from pathlib import Path

import numpy as np
import soundfile as sf

from audiotool_ml_worker.texture_split import create_texture_split


def test_texture_outputs_are_full_length_and_complementary(tmp_path: Path) -> None:
    sample_rate = 16_000
    seconds = 2
    timeline = np.arange(sample_rate * seconds, dtype=np.float32) / sample_rate
    sustained = 0.24 * np.sin(2 * np.pi * 330 * timeline)
    clicks = np.zeros_like(sustained)
    clicks[:: sample_rate // 4] = 0.8
    source = np.column_stack((sustained + clicks, sustained + clicks)).astype(np.float32)
    source_path = tmp_path / "other.wav"
    sf.write(source_path, source, sample_rate, subtype="FLOAT")

    create_texture_split(source_path, tmp_path)

    harmonic, harmonic_rate = sf.read(tmp_path / "synthesizer.wav", dtype="float32")
    percussive, percussive_rate = sf.read(tmp_path / "percussion.wav", dtype="float32")
    assert harmonic_rate == sample_rate
    assert percussive_rate == sample_rate
    assert harmonic.shape == source.shape
    assert percussive.shape == source.shape
    reconstruction = harmonic + percussive
    assert float(np.sqrt(np.mean((reconstruction - source) ** 2))) < 1e-5
    assert float(np.sqrt(np.mean(harmonic**2))) > 0.01
    assert float(np.max(np.abs(percussive))) > 0.1
