"""Run a reproducible, locally generated benchmark through the real ML HTTP worker.

The corpus is synthesized at runtime and contains no third-party recordings. It is intentionally
small: three labelled six-second scenes are concatenated into one inference request so the CPU-only
benchmark remains practical while still exercising all six htdemucs_6s outputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import demucs
import numpy as np
import soundfile as sf
import torch

from audiotool_ml_worker.metrics import (
    decibels as _db,
    rms as _rms,
    source_metrics as _metrics,
)

LABELS = ("vocals", "drums", "bass_guitar", "guitar", "piano", "other")
SCENES = (
    ("rhythm_and_voice", 0.0, 6.0),
    ("acoustic_instruments", 6.0, 12.0),
    ("dense_six_source_mix", 12.0, 18.0),
)


@dataclass(frozen=True)
class BenchmarkConfig:
    worker_url: str
    output_root: Path
    sample_rate: int = 44_100
    duration_seconds: float = 18.0
    timeout_seconds: int = 1_800


def _stereo(mono: np.ndarray, pan: float) -> np.ndarray:
    angle = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4.0
    return np.column_stack((mono * math.cos(angle), mono * math.sin(angle)))


def _add_tone(
    target: np.ndarray,
    sample_rate: int,
    start: float,
    duration: float,
    frequency: float,
    amplitude: float,
    harmonics: tuple[float, ...],
    vibrato: float = 0.0,
) -> None:
    start_index = max(0, round(start * sample_rate))
    count = min(len(target) - start_index, round(duration * sample_rate))
    if count <= 0:
        return
    timeline = np.arange(count, dtype=np.float64) / sample_rate
    phase = 2 * math.pi * frequency * timeline
    if vibrato:
        phase += vibrato * np.sin(2 * math.pi * 5.2 * timeline)
    signal = np.zeros(count, dtype=np.float64)
    for index, weight in enumerate(harmonics, start=1):
        signal += weight * np.sin(index * phase)
    attack = np.minimum(1.0, timeline / 0.035)
    release = np.minimum(1.0, np.maximum(0.0, (duration - timeline) / 0.08))
    target[start_index : start_index + count] += amplitude * signal * attack * release


def _add_pluck(
    target: np.ndarray,
    sample_rate: int,
    start: float,
    frequency: float,
    amplitude: float,
    decay: float,
) -> None:
    duration = min(2.4, max(0.0, len(target) / sample_rate - start))
    start_index = round(start * sample_rate)
    count = round(duration * sample_rate)
    if count <= 0:
        return
    timeline = np.arange(count, dtype=np.float64) / sample_rate
    signal = sum(
        (1 / harmonic) * np.sin(2 * math.pi * frequency * harmonic * timeline)
        for harmonic in range(1, 8)
    )
    envelope = np.exp(-timeline * decay) * np.minimum(1.0, timeline / 0.004)
    target[start_index : start_index + count] += amplitude * signal * envelope


def _synthesize(config: BenchmarkConfig) -> tuple[Path, dict[str, Path]]:
    corpus_root = config.output_root / "corpus"
    target_root = corpus_root / "targets"
    target_root.mkdir(parents=True, exist_ok=True)
    count = round(config.sample_rate * config.duration_seconds)
    mono = {label: np.zeros(count, dtype=np.float64) for label in LABELS}
    rng = np.random.default_rng(20_260_718)

    # Voice-like harmonic phrases in scenes one and three.
    vocal_notes = (220.0, 246.94, 261.63, 293.66, 329.63, 293.66)
    for scene_start in (0.0, 12.0):
        for index, frequency in enumerate(vocal_notes):
            _add_tone(
                mono["vocals"],
                config.sample_rate,
                scene_start + index,
                0.82,
                frequency,
                0.17,
                (1.0, 0.45, 0.22, 0.1),
                vibrato=0.035,
            )

    # Bass is present in every scene and changes notes every second.
    bass_notes = (55.0, 65.41, 73.42, 82.41, 65.41, 55.0)
    for scene_start in (0.0, 6.0, 12.0):
        for index, frequency in enumerate(bass_notes):
            _add_tone(
                mono["bass_guitar"],
                config.sample_rate,
                scene_start + index,
                0.88,
                frequency,
                0.22,
                (1.0, 0.35, 0.14),
            )

    # Deterministic kick, snare and hi-hat pattern in scenes one and three.
    for scene_start in (0.0, 12.0):
        for beat in np.arange(scene_start, scene_start + 6.0, 0.5):
            start = round(beat * config.sample_rate)
            length = min(round(0.22 * config.sample_rate), count - start)
            timeline = np.arange(length, dtype=np.float64) / config.sample_rate
            kick = np.sin(2 * math.pi * (82 * timeline - 36 * timeline**2))
            mono["drums"][start : start + length] += 0.33 * kick * np.exp(-18 * timeline)
        for beat in np.arange(scene_start + 0.5, scene_start + 6.0, 1.0):
            start = round(beat * config.sample_rate)
            length = min(round(0.18 * config.sample_rate), count - start)
            noise = rng.normal(0.0, 1.0, length)
            high_passed = np.concatenate(([noise[0]], np.diff(noise)))
            timeline = np.arange(length, dtype=np.float64) / config.sample_rate
            mono["drums"][start : start + length] += 0.16 * high_passed * np.exp(-22 * timeline)
        for beat in np.arange(scene_start, scene_start + 6.0, 0.25):
            start = round(beat * config.sample_rate)
            length = min(round(0.045 * config.sample_rate), count - start)
            noise = rng.normal(0.0, 1.0, length)
            high_passed = np.concatenate(([noise[0]], np.diff(noise)))
            timeline = np.arange(length, dtype=np.float64) / config.sample_rate
            mono["drums"][start : start + length] += 0.035 * high_passed * np.exp(-65 * timeline)

    # Guitar-like plucks and piano-like chord attacks in scenes two and three.
    guitar_notes = (164.81, 196.0, 220.0, 246.94, 220.0, 196.0)
    for scene_start in (6.0, 12.0):
        for index, frequency in enumerate(guitar_notes):
            _add_pluck(
                mono["guitar"], config.sample_rate, scene_start + index, frequency, 0.09, 2.8
            )
    piano_chords = ((261.63, 329.63, 392.0), (293.66, 369.99, 440.0), (220.0, 329.63, 440.0))
    for scene_start in (6.0, 12.0):
        for chord_index, chord in enumerate(piano_chords):
            for frequency in chord:
                _add_pluck(
                    mono["piano"],
                    config.sample_rate,
                    scene_start + chord_index * 2.0,
                    frequency,
                    0.055,
                    1.4,
                )

    # A slow string/pad-like source represents the checkpoint's residual/other target.
    for frequency in (130.81, 196.0, 261.63):
        _add_tone(
            mono["other"],
            config.sample_rate,
            12.0,
            5.9,
            frequency,
            0.055,
            (1.0, 0.22, 0.08),
        )

    pans = {
        "vocals": 0.0,
        "drums": 0.0,
        "bass_guitar": -0.1,
        "guitar": -0.55,
        "piano": 0.5,
        "other": 0.2,
    }
    stereo_targets = {label: _stereo(values, pans[label]) for label, values in mono.items()}
    mixture = sum(stereo_targets.values(), start=np.zeros((count, 2), dtype=np.float64))
    scale = 0.92 / max(0.92, float(np.max(np.abs(mixture))))
    mixture *= scale
    target_paths: dict[str, Path] = {}
    for label, values in stereo_targets.items():
        path = target_root / f"{label}.wav"
        sf.write(path, values * scale, config.sample_rate, subtype="FLOAT")
        target_paths[label] = path
    mixture_path = corpus_root / "mixture.wav"
    sf.write(mixture_path, mixture, config.sample_rate, subtype="FLOAT")
    return mixture_path, target_paths


def _json_request(url: str, timeout: int) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post_audio(
    url: str,
    audio: bytes,
    headers: dict[str, str],
    timeout: int,
) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        data=audio,
        method="POST",
        headers={"Content-Type": "application/octet-stream", **headers},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get_content_type()


def _load_audio(path: Path) -> tuple[np.ndarray, int]:
    values, sample_rate = sf.read(path, dtype="float64", always_2d=True)
    return values, sample_rate


def _checkpoint_inventory() -> list[dict[str, Any]]:
    roots = [Path(torch.hub.get_dir()), Path.home() / ".cache" / "huggingface" / "hub"]
    suffixes = {".th", ".pt", ".pth", ".ckpt", ".safetensors"}
    inventory: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            inventory.append(
                {
                    "fileName": path.name,
                    "cache": "huggingface" if "huggingface" in path.parts else "torch-hub",
                    "sizeBytes": path.stat().st_size,
                    "sha256": digest.hexdigest(),
                }
            )
    return inventory


def _markdown(result: dict[str, Any]) -> str:
    rows = []
    for label, metrics in result["globalMetrics"].items():
        rows.append(
            "| {label} | {ref} | {est} | {sdr} | {gain} |".format(
                label=label,
                ref=metrics["referenceRmsDbfs"],
                est=metrics["estimateRmsDbfs"],
                sdr=metrics["siSdrDb"],
                gain=metrics["siSdrImprovementDb"],
            )
        )
    detected = ", ".join(item["canonicalLabel"] for item in result["detections"])
    checkpoints = "\n".join(
        f"- `{item['sha256']}` ({item['sizeBytes']} bytes)"
        for item in result["environment"]["checkpoints"]
    )
    row_text = "\n".join(rows)
    return f"""# Demucs real-provider benchmark

Generated: {result["generatedAt"]}

This result uses a deterministic, runtime-generated 18-second corpus. No commercial or
third-party audio is included. The three six-second scenes cover rhythm/voice, guitar/piano, and a
dense six-source mix.

## Runtime

- Provider: `{result["provider"]["provider"]}` / `{result["provider"]["modelName"]}`
- Python: `{result["environment"]["python"]}`
- PyTorch: `{result["environment"]["torch"]}`
- Demucs: `{result["environment"]["demucs"]}`
- Device: `{result["environment"]["device"]}`
- CPU: `{result["environment"]["cpu"]}`
- Cold inference: `{result["timing"]["inferenceSeconds"]} s`
- Real-time factor: `{result["timing"]["realTimeFactor"]}`
- Reconstruction error: `{result["reconstructionErrorDb"]} dB` (lower is better)
- Detected labels: {detected or "none"}

## Global source metrics

| Label | Reference RMS dBFS | Estimate RMS dBFS | SI-SDR dB | SI-SDR improvement dB |
| --- | ---: | ---: | ---: | ---: |
{row_text}

Synthetic timbres are deliberately unlike the copyrighted recordings on which music separators
are normally evaluated. These numbers prove that the real checkpoint and HTTP contract execute
reproducibly; they are not a production-quality claim. Listen and evaluate on an authorized,
representative music corpus before enabling the provider commercially.

## Checkpoint files

{checkpoints or "- No checkpoint file was discovered in the standard caches."}

Full per-scene metrics and exact environment data are in the adjacent JSON file.
"""


def run(config: BenchmarkConfig) -> dict[str, Any]:
    config.output_root.mkdir(parents=True, exist_ok=True)
    mixture_path, target_paths = _synthesize(config)
    audio = mixture_path.read_bytes()
    checksum = hashlib.sha256(audio).hexdigest()
    info = _json_request(f"{config.worker_url}/v1/info", config.timeout_seconds)
    health = _json_request(f"{config.worker_url}/health", config.timeout_seconds)
    if health.get("available") is not True:
        raise RuntimeError(f"ML worker is not ready: {health}")

    started = time.perf_counter()
    detection_bytes, _ = _post_audio(
        f"{config.worker_url}/v1/detect",
        audio,
        {
            "X-Audio-Checksum": checksum,
            "X-Audio-Duration-Ms": str(round(config.duration_seconds * 1000)),
        },
        config.timeout_seconds,
    )
    inference_seconds = time.perf_counter() - started
    detection_response = json.loads(detection_bytes.decode("utf-8"))

    estimates: dict[str, np.ndarray] = {}
    estimate_root = config.output_root / "estimates"
    estimate_root.mkdir(parents=True, exist_ok=True)
    for label in LABELS:
        stem_bytes, content_type = _post_audio(
            f"{config.worker_url}/v1/separate/{label}",
            audio,
            {"X-Audio-Checksum": checksum},
            config.timeout_seconds,
        )
        if content_type != "audio/wav":
            raise RuntimeError(f"Unexpected content type for {label}: {content_type}")
        stem_path = estimate_root / f"{label}.wav"
        stem_path.write_bytes(stem_bytes)
        estimates[label], estimate_rate = _load_audio(stem_path)
        if estimate_rate != config.sample_rate:
            raise RuntimeError(f"Unexpected sample rate for {label}: {estimate_rate}")

    mixture, mixture_rate = _load_audio(mixture_path)
    if mixture_rate != config.sample_rate:
        raise RuntimeError(f"Unexpected mixture sample rate: {mixture_rate}")
    references = {label: _load_audio(path)[0] for label, path in target_paths.items()}
    global_metrics = {
        label: _metrics(references[label], estimates[label], mixture) for label in LABELS
    }
    scene_metrics: dict[str, dict[str, dict[str, float | None]]] = {}
    for name, start, end in SCENES:
        first = round(start * config.sample_rate)
        last = round(end * config.sample_rate)
        scene_metrics[name] = {
            label: _metrics(
                references[label][first:last],
                estimates[label][first:last],
                mixture[first:last],
            )
            for label in LABELS
            if _rms(references[label][first:last]) > 1e-7
        }

    common_length = min(len(mixture), *(len(value) for value in estimates.values()))
    reconstructed = sum(
        (values[:common_length] for values in estimates.values()),
        start=np.zeros_like(mixture[:common_length]),
    )
    reconstruction_error = _db(
        _rms(reconstructed - mixture[:common_length]) / max(_rms(mixture[:common_length]), 1e-12)
    )
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "corpus": {
            "provenance": "Project-generated synthetic audio; no third-party source material",
            "sampleRate": config.sample_rate,
            "durationSeconds": config.duration_seconds,
            "sha256": checksum,
            "scenes": [
                {"name": name, "startSeconds": start, "endSeconds": end}
                for name, start, end in SCENES
            ],
        },
        "provider": info,
        "health": health,
        "detections": detection_response["detections"],
        "timing": {
            "inferenceSeconds": round(inference_seconds, 3),
            "realTimeFactor": round(inference_seconds / config.duration_seconds, 3),
        },
        "reconstructionErrorDb": round(reconstruction_error, 3),
        "globalMetrics": global_metrics,
        "sceneMetrics": scene_metrics,
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "demucs": getattr(demucs, "__version__", "4.1.0"),
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "cudaVersion": torch.version.cuda,
            "cpu": platform.processor() or platform.machine(),
            "logicalCpuCount": os.cpu_count(),
            "platform": platform.platform(),
            "checkpoints": _checkpoint_inventory(),
        },
    }
    json_path = config.output_root / "result.json"
    markdown_path = config.output_root / "result.md"
    json_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    markdown_path.write_text(_markdown(result), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "benchmark-output",
    )
    parser.add_argument("--timeout-seconds", type=int, default=1_800)
    arguments = parser.parse_args()
    result = run(
        BenchmarkConfig(
            worker_url=arguments.worker_url.rstrip("/"),
            output_root=arguments.output.resolve(),
            timeout_seconds=arguments.timeout_seconds,
        )
    )
    print(
        json.dumps(
            {
                "result": str((arguments.output / "result.json").resolve()),
                "inferenceSeconds": result["timing"]["inferenceSeconds"],
                "realTimeFactor": result["timing"]["realTimeFactor"],
                "reconstructionErrorDb": result["reconstructionErrorDb"],
                "detectedLabels": [item["canonicalLabel"] for item in result["detections"]],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
