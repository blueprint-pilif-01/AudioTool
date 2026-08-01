from __future__ import annotations

import math

import numpy as np


def rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values), dtype=np.float64)))


def decibels(value: float) -> float:
    return 20 * math.log10(max(value, 1e-12))


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float | None:
    reference = reference.reshape(-1) - float(np.mean(reference))
    estimate = estimate.reshape(-1) - float(np.mean(estimate))
    reference_energy = float(np.dot(reference, reference))
    if reference_energy <= 1e-12:
        return None
    projection = reference * (float(np.dot(estimate, reference)) / reference_energy)
    noise = estimate - projection
    return 10 * math.log10(
        max(float(np.dot(projection, projection)), 1e-12) / max(float(np.dot(noise, noise)), 1e-12)
    )


def source_metrics(
    reference: np.ndarray,
    estimate: np.ndarray,
    mixture: np.ndarray,
) -> dict[str, float | None]:
    length = min(len(reference), len(estimate), len(mixture))
    reference = reference[:length]
    estimate = estimate[:length]
    mixture = mixture[:length]
    estimate_score = si_sdr(reference, estimate)
    mixture_score = si_sdr(reference, mixture)
    return {
        "referenceRmsDbfs": round(decibels(rms(reference)), 3),
        "estimateRmsDbfs": round(decibels(rms(estimate)), 3),
        "siSdrDb": None if estimate_score is None else round(estimate_score, 3),
        "mixtureSiSdrDb": None if mixture_score is None else round(mixture_score, 3),
        "siSdrImprovementDb": (
            None
            if estimate_score is None or mixture_score is None
            else round(estimate_score - mixture_score, 3)
        ),
    }
