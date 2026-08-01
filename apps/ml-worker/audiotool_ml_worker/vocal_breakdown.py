from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

MODEL_NAME = "dominant-pitch-register-gating"
MODEL_VERSION = "1.0.0"
TARGETS = ("melody", "soprano", "alto", "tenor", "bass")
REGISTER_ORDER = ("bass", "tenor", "alto", "soprano")
REGISTER_META = {
    "bass": ("Bass focus", "C2–B2"),
    "tenor": ("Tenor focus", "C3–A3"),
    "alto": ("Alto focus", "A♯3–F4"),
    "soprano": ("Soprano focus", "F♯4–C6"),
}
NOTE_NAMES = ("C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B")


def _note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def _frequency(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _register(midi: int) -> str:
    if midi <= 47:
        return "bass"
    if midi <= 57:
        return "tenor"
    if midi <= 65:
        return "alto"
    return "soprano"


def _smooth_midi(values: np.ndarray, voiced: np.ndarray) -> np.ndarray:
    smoothed = values.copy()
    for index in range(values.size):
        if not voiced[index]:
            continue
        first = max(0, index - 2)
        last = min(values.size, index + 3)
        neighbors = values[first:last][voiced[first:last]]
        if neighbors.size:
            smoothed[index] = int(round(float(np.median(neighbors))))
    return smoothed


def _detect_pitch(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, ...]:
    mono = np.mean(audio, axis=1, dtype=np.float32)
    decimation = max(1, int(round(sample_rate / 8_000)))
    analysis = mono[::decimation]
    analysis_rate = sample_rate / decimation
    frame_length = 2_048
    hop_length = 512
    if analysis.size < frame_length:
        analysis = np.pad(analysis, (0, frame_length - analysis.size))
    starts = np.arange(0, max(1, analysis.size - frame_length + 1), hop_length, dtype=np.int64)
    if starts[-1] + frame_length < analysis.size:
        starts = np.append(starts, analysis.size - frame_length)

    candidate_midi = np.arange(36, 85, dtype=np.int16)
    candidate_frequencies = 440.0 * (2.0 ** ((candidate_midi - 69) / 12.0))
    bin_hz = analysis_rate / frame_length
    window = np.hanning(frame_length).astype(np.float32)
    frame_offsets = np.arange(frame_length, dtype=np.int64)
    detected_midi = np.full(starts.size, -1, dtype=np.int16)
    confidence = np.zeros(starts.size, dtype=np.float32)
    rms = np.zeros(starts.size, dtype=np.float32)

    batch_size = 192
    for first in range(0, starts.size, batch_size):
        batch_starts = starts[first : first + batch_size]
        frames = analysis[batch_starts[:, None] + frame_offsets[None, :]] * window
        rms_batch = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        magnitudes = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)
        scores = np.zeros((frames.shape[0], candidate_midi.size), dtype=np.float32)
        for harmonic in range(1, 6):
            bins = np.rint(candidate_frequencies * harmonic / bin_hz).astype(np.int32)
            valid = bins < magnitudes.shape[1]
            scores[:, valid] += magnitudes[:, bins[valid]] / (harmonic**0.72)
        best_indices = np.argmax(scores, axis=1)
        best_scores = scores[np.arange(scores.shape[0]), best_indices]
        average_scores = np.mean(scores, axis=1) + 1e-9
        clarity = best_scores / average_scores
        confidence_batch = np.clip((clarity - 1.15) / 5.0, 0.0, 1.0)
        detected_midi[first : first + frames.shape[0]] = candidate_midi[best_indices]
        confidence[first : first + frames.shape[0]] = confidence_batch
        rms[first : first + frames.shape[0]] = rms_batch

    energy_floor = max(1e-5, float(np.percentile(rms, 80)) * 0.06)
    voiced = (rms >= energy_floor) & (confidence >= 0.08)
    detected_midi = _smooth_midi(detected_midi, voiced)
    centers = ((starts + frame_length / 2) * decimation).astype(np.float64)
    return detected_midi, confidence, voiced, centers


def _note_events(
    midi: np.ndarray,
    confidence: np.ndarray,
    voiced: np.ndarray,
    centers: np.ndarray,
    sample_rate: int,
    duration_frames: int,
) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    index = 0
    typical_step = float(np.median(np.diff(centers))) if centers.size > 1 else sample_rate * 0.05
    while index < midi.size:
        if not voiced[index]:
            index += 1
            continue
        note = int(midi[index])
        first = index
        index += 1
        while index < midi.size and voiced[index] and abs(int(midi[index]) - note) <= 1:
            index += 1
        start_frame = max(0.0, centers[first] - typical_step / 2)
        end_frame = min(float(duration_frames), centers[index - 1] + typical_step / 2)
        if end_frame - start_frame < sample_rate * 0.08:
            continue
        representative = int(round(float(np.median(midi[first:index]))))
        events.append(
            {
                "startMs": round(start_frame / sample_rate * 1_000),
                "endMs": round(end_frame / sample_rate * 1_000),
                "midi": representative,
                "note": _note_name(representative),
                "frequencyHz": round(_frequency(representative), 2),
                "confidence": round(float(np.mean(confidence[first:index])), 4),
                "register": _register(representative),
            }
        )
        if len(events) >= 600:
            break
    return events


def _write_outputs(
    directory: Path,
    audio: np.ndarray,
    sample_rate: int,
    midi: np.ndarray,
    confidence: np.ndarray,
    voiced: np.ndarray,
    centers: np.ndarray,
) -> list[dict[str, object]]:
    frame_envelopes: dict[str, np.ndarray] = {}
    register_values = np.array(
        [_register(int(value)) if is_voiced else "none" for value, is_voiced in zip(midi, voiced)],
        dtype="<U8",
    )
    kernel = np.ones(5, dtype=np.float32) / 5.0
    for register in REGISTER_ORDER:
        raw = (register_values == register).astype(np.float32)
        frame_envelopes[register] = np.convolve(raw, kernel, mode="same")
    total = sum(frame_envelopes.values())
    active = total > 1e-6
    for register in REGISTER_ORDER:
        frame_envelopes[register][active] /= total[active]

    summaries: list[dict[str, object]] = []
    voiced_count = max(1, int(np.count_nonzero(voiced)))
    for register in REGISTER_ORDER:
        mask = register_values == register
        display_name, range_name = REGISTER_META[register]
        summaries.append(
            {
                "part": register,
                "displayName": display_name,
                "range": range_name,
                "coverage": round(float(np.count_nonzero(mask)) / voiced_count, 4),
                "confidence": round(float(np.mean(confidence[mask])) if np.any(mask) else 0.0, 4),
            }
        )

    block_size = 131_072
    with sf.SoundFile(
        directory / "melody.wav",
        mode="w",
        samplerate=sample_rate,
        channels=1,
        format="WAV",
        subtype="FLOAT",
    ) as melody_writer:
        phase = 0.0
        for first in range(0, audio.shape[0], block_size):
            last = min(audio.shape[0], first + block_size)
            positions = np.arange(first, last, dtype=np.float64)
            frequencies = np.interp(
                positions,
                centers,
                np.where(voiced, 440.0 * (2.0 ** ((midi - 69) / 12.0)), 0.0),
                left=0.0,
                right=0.0,
            )
            amplitude = np.interp(
                positions,
                centers,
                np.where(voiced, confidence, 0.0),
                left=0.0,
                right=0.0,
            )
            increments = 2 * math.pi * frequencies / sample_rate
            phases = phase + np.cumsum(increments)
            if phases.size:
                phase = float(phases[-1] % (2 * math.pi))
            melody = (np.sin(phases) + 0.22 * np.sin(2 * phases)) * amplitude * 0.16
            melody_writer.write(melody.astype(np.float32))

    writers = {
        register: sf.SoundFile(
            directory / f"{register}.wav",
            mode="w",
            samplerate=sample_rate,
            channels=audio.shape[1],
            format="WAV",
            subtype="FLOAT",
        )
        for register in REGISTER_ORDER
    }
    try:
        for first in range(0, audio.shape[0], block_size):
            last = min(audio.shape[0], first + block_size)
            positions = np.arange(first, last, dtype=np.float64)
            block = audio[first:last]
            for register, writer in writers.items():
                envelope = np.interp(
                    positions,
                    centers,
                    frame_envelopes[register],
                    left=0.0,
                    right=0.0,
                ).astype(np.float32)
                writer.write(block * envelope[:, None])
    finally:
        for writer in writers.values():
            writer.close()
    return summaries


def create_vocal_breakdown(source: Path, directory: Path) -> dict[str, object]:
    directory.mkdir(parents=True, exist_ok=True)
    audio, sample_rate = sf.read(source, dtype="float32", always_2d=True)
    if audio.shape[0] == 0:
        raise ValueError("Vocal stem is empty.")
    midi, confidence, voiced, centers = _detect_pitch(audio, sample_rate)
    summaries = _write_outputs(directory, audio, sample_rate, midi, confidence, voiced, centers)
    events = _note_events(midi, confidence, voiced, centers, sample_rate, audio.shape[0])
    voiced_midi = midi[voiced]
    voiced_confidence = confidence[voiced]
    hop_ms = float(np.median(np.diff(centers))) / sample_rate * 1_000 if centers.size > 1 else 0.0
    analysis: dict[str, object] = {
        "durationMs": round(audio.shape[0] / sample_rate * 1_000),
        "voicedDurationMs": round(np.count_nonzero(voiced) * hop_ms),
        "confidence": round(float(np.mean(voiced_confidence)) if voiced_midi.size else 0.0, 4),
        "lowestNote": _note_name(int(np.min(voiced_midi))) if voiced_midi.size else None,
        "highestNote": _note_name(int(np.max(voiced_midi))) if voiced_midi.size else None,
        "medianNote": _note_name(int(round(float(np.median(voiced_midi)))))
        if voiced_midi.size
        else None,
        "notes": events,
        "registers": summaries,
        "modelName": MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "methodology": "dominant-pitch-register-gating",
        "experimental": True,
    }
    (directory / "analysis.json").write_text(
        json.dumps(analysis, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return analysis


def read_analysis(directory: Path) -> dict[str, object]:
    return json.loads((directory / "analysis.json").read_text(encoding="utf-8"))
