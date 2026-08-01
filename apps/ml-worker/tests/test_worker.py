from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from audiotool_ml_worker import main


def test_health_and_capabilities_report_real_demucs() -> None:
    with TestClient(main.app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {
            "status": "ready",
            "backend": "demucs",
            "modelName": "htdemucs_6s",
            "vocalModelName": "htdemucs_ft",
            "modelVersion": "demucs-4.1.0",
            "modelShifts": 0,
            "available": True,
            "supportedLabels": [
                "vocals",
                "drums",
                "bass_guitar",
                "guitar",
                "piano",
                "other",
                "instrumental",
                "synthesizer",
                "percussion",
            ],
        }

        info = client.get("/v1/info")
        assert info.status_code == 200
        assert info.json()["modelShifts"] == 0
        assert info.json()["dynamicStemCount"] is True


def test_unknown_target_is_rejected_before_inference() -> None:
    with TestClient(main.app) as client:
        response = client.post(
            "/v1/separate/saxophone",
            headers={"X-Audio-Checksum": "0" * 64},
            content=b"not-used",
        )
    assert response.status_code == 422
    assert "not supported" in response.json()["detail"]


def test_cache_marker_includes_model_configuration(tmp_path: Path) -> None:
    marker = tmp_path / ".complete"
    marker.write_text(main._cache_signature(), encoding="utf-8")
    assert main._cache_is_valid(marker)

    marker.write_text("htdemucs_6s\ndemucs-4.1.0\n", encoding="utf-8")
    assert not main._cache_is_valid(marker)


def test_instrumental_is_the_sum_of_non_vocal_sources(tmp_path: Path) -> None:
    sample_rate = 8_000
    frames = 4_000
    sources = ("vocals", "drums", "bass", "other")
    values = {"vocals": 0.4, "drums": 0.1, "bass": 0.2, "other": -0.05}
    for source in sources:
        audio = np.full((frames, 2), values[source], dtype=np.float32)
        sf.write(tmp_path / f"{source}.wav", audio, sample_rate, subtype="FLOAT")

    main._write_instrumental(tmp_path, sources)

    instrumental, written_rate = sf.read(
        tmp_path / "instrumental.wav", dtype="float32", always_2d=True
    )
    assert written_rate == sample_rate
    assert np.allclose(instrumental, 0.25, atol=1e-6)
    assert not np.allclose(instrumental, values["vocals"], atol=1e-6)
