import numpy as np

from audiotool_ml_worker.metrics import si_sdr, source_metrics


def test_quality_metrics_reward_a_perfect_estimate() -> None:
    timeline = np.linspace(0, 1, 44_100, endpoint=False)
    reference = np.sin(2 * np.pi * 440 * timeline)[:, np.newaxis]
    interference = 0.25 * np.sin(2 * np.pi * 880 * timeline)[:, np.newaxis]
    mixture = reference + interference

    score = si_sdr(reference, reference)
    metrics = source_metrics(reference, reference, mixture)

    assert score is not None and score > 100
    assert metrics["siSdrDb"] is not None
    assert metrics["siSdrImprovementDb"] is not None
    assert metrics["siSdrImprovementDb"] > 80
