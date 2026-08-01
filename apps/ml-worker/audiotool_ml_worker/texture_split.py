from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

MODEL_NAME = "residual-texture-split"
MODEL_VERSION = "1.0.0"
HARMONIC_FILENAME = "synthesizer.wav"
PERCUSSIVE_FILENAME = "percussion.wav"


def create_texture_split(source_path: Path, output_directory: Path) -> None:
    """Split Demucs `other` into complementary sustained and transient textures.

    This is deliberately labelled as a texture split, not semantic instrument recognition.
    The two outputs sum back to the input residual (within floating-point precision).
    """

    output_directory.mkdir(parents=True, exist_ok=True)
    harmonic_path = output_directory / HARMONIC_FILENAME
    percussive_path = output_directory / PERCUSSIVE_FILENAME
    harmonic_temporary = output_directory / f"{HARMONIC_FILENAME}.creating"
    percussive_temporary = output_directory / f"{PERCUSSIVE_FILENAME}.creating"
    harmonic_temporary.unlink(missing_ok=True)
    percussive_temporary.unlink(missing_ok=True)

    frame_length = 2048
    hop_length = 512
    window = np.hanning(frame_length).astype(np.float32)
    window_square = window * window

    try:
        with (
            sf.SoundFile(source_path, mode="r") as reader,
            sf.SoundFile(
                harmonic_temporary,
                mode="w",
                samplerate=reader.samplerate,
                channels=reader.channels,
                format="WAV",
                subtype="FLOAT",
            ) as harmonic_writer,
            sf.SoundFile(
                percussive_temporary,
                mode="w",
                samplerate=reader.samplerate,
                channels=reader.channels,
                format="WAV",
                subtype="FLOAT",
            ) as percussive_writer,
        ):
            total_frames = int(reader.frames)
            channels = int(reader.channels)
            frame = reader.read(frame_length, dtype="float32", always_2d=True)
            if frame.shape[0] < frame_length:
                frame = np.pad(frame, ((0, frame_length - frame.shape[0]), (0, 0)))

            overlap = np.zeros((frame_length, channels), dtype=np.float32)
            normalization = np.zeros(frame_length, dtype=np.float32)
            smoothed_magnitude: np.ndarray | None = None
            written = 0

            while written < total_frames:
                spectrum = np.fft.rfft(frame * window[:, None], axis=0)
                magnitude = np.abs(spectrum).astype(np.float32)
                if smoothed_magnitude is None:
                    smoothed_magnitude = magnitude.copy()
                stationarity = smoothed_magnitude / np.maximum(magnitude, 1e-7)
                harmonic_mask = np.clip((stationarity - 0.18) / 0.82, 0.03, 0.97)
                smoothed_magnitude = 0.94 * smoothed_magnitude + 0.06 * magnitude

                harmonic_frame = np.fft.irfft(
                    spectrum * harmonic_mask, n=frame_length, axis=0
                ).astype(np.float32)
                overlap += harmonic_frame * window[:, None]
                normalization += window_square

                output_count = min(hop_length, total_frames - written)
                harmonic_output = overlap[:output_count] / np.maximum(
                    normalization[:output_count, None], 1e-7
                )
                original_output = frame[:output_count]
                percussive_output = original_output - harmonic_output
                # FLOAT WAV preserves the complementary pair without clipping either side.
                harmonic_writer.write(harmonic_output)
                percussive_writer.write(percussive_output)

                overlap[:-hop_length] = overlap[hop_length:]
                overlap[-hop_length:] = 0
                normalization[:-hop_length] = normalization[hop_length:]
                normalization[-hop_length:] = 0
                written += output_count
                if written >= total_frames:
                    break

                incoming = reader.read(hop_length, dtype="float32", always_2d=True)
                if incoming.shape[0] < hop_length:
                    incoming = np.pad(
                        incoming,
                        ((0, hop_length - incoming.shape[0]), (0, 0)),
                    )
                frame[:-hop_length] = frame[hop_length:]
                frame[-hop_length:] = incoming

        harmonic_temporary.replace(harmonic_path)
        percussive_temporary.replace(percussive_path)
    finally:
        harmonic_temporary.unlink(missing_ok=True)
        percussive_temporary.unlink(missing_ok=True)
