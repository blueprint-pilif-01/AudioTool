from pathlib import Path

import numpy as np
import soundfile as sf

from audiotool_ml_worker.vocal_breakdown import TARGETS, create_vocal_breakdown


def test_vocal_breakdown_writes_melody_and_register_focus_tracks(tmp_path: Path) -> None:
    sample_rate = 16_000
    seconds = 1.25
    time = np.arange(round(sample_rate * seconds), dtype=np.float32) / sample_rate
    low = 0.35 * np.sin(2 * np.pi * 220 * time)
    high = 0.35 * np.sin(2 * np.pi * 440 * time)
    audio = np.concatenate([low, high]).astype(np.float32)
    source = tmp_path / "vocals.wav"
    output = tmp_path / "breakdown"
    sf.write(source, np.column_stack([audio, audio]), sample_rate, subtype="FLOAT")

    analysis = create_vocal_breakdown(source, output)

    assert analysis["durationMs"] == 2_500
    assert analysis["experimental"] is True
    assert float(analysis["confidence"]) > 0
    assert len(analysis["notes"]) >= 2
    assert {event["note"] for event in analysis["notes"]} >= {"A3", "A4"}
    summaries = {item["part"]: item for item in analysis["registers"]}
    assert float(summaries["tenor"]["coverage"]) > 0.2
    assert float(summaries["soprano"]["coverage"]) > 0.2

    for target in TARGETS:
        path = output / f"{target}.wav"
        assert path.exists()
        rendered, rendered_rate = sf.read(path, always_2d=True)
        assert rendered_rate == sample_rate
        assert rendered.shape[0] == audio.shape[0]
