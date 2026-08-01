# Model evaluation plan

No model should be enabled for a label merely because its API accepted that label.

## Corpus

Build a small, redistributable or internally licensed corpus containing isolated sources and full
mixes across genres. Record license/provenance, sample rate, duration, true source taxonomy, and
known bleed. Include silence, short files, dense mixes, live recordings, and instruments that are
absent. Do not commit commercial songs.

## Measurements

- Detection: per-label precision, recall, F1, calibration, false positives on absent instruments.
- Separation: SI-SDR/SDR improvement, bleed/interference, artifact rate, and residual energy.
- Reconstruction: loudness-aligned error between original mix and summed stems.
- Operations: real-time factor, peak RAM/VRAM, cold/warm latency, output size, cancellation delay.
- Product review: blinded listening on headphones and monitors, plus mixer usability.

Track results by model name, exact checkpoint hash, provider version, hardware, dependency lock,
FFmpeg build, and configuration. Establish thresholds per label and disable labels that do not meet
them.

## Current Demucs slice

Evaluate `htdemucs_6s` only for its documented six sources. Do not infer that an energetic `other`
stem proves the presence of a specific instrument. Compare the six outputs against the original,
verify cache integrity, and measure both CPU and target-GPU performance before production rollout.

The first CPU evaluation is complete and recorded in
`benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md`. It uses three deterministic synthetic scenes in
one 18-second inference request. Cache-miss inference completed at a 0.685 real-time factor. Bass
and drums improved strongly, piano improved moderately, while the synthetic vocals and guitar did
not. Reconstruction error was -23.192 dB and missed the -30 dB review threshold. A representative
authorized-music listening test and GPU run remain required before production rollout.

## Vocal remover profile

Quick mode uses the official fine-tuned `htdemucs_ft` ensemble. The worker generates vocals and
constructs accompaniment by summing the non-vocal Demucs sources in streaming blocks. The real
Fastify/PostgreSQL integration run completed both the six-source and quick two-source paths in
69.32 seconds on the local CPU, including HTTP, persistence, FFprobe, and reconstruction checks.

That integration run proves routing, caching, model metadata, and that instrumental is not a copy
of the source mix. It does not establish perceptual vocal-removal quality: the generated benchmark
uses synthetic tones rather than natural singing, and its vocal score must not be generalized to
music. Before a public quality claim, add authorized recordings with isolated natural vocals,
measure vocal bleed in the accompaniment, and run blinded listening against other legally usable
vocal-specialist checkpoints.

## Candidate expansion

Banquet, SAM-Audio, AudioSep, or another query-conditioned system must be evaluated independently.
The Node transport profiles are contract-only integration points. Check code license and
checkpoint/data license separately, then activate a compatible worker only after a reproducible
benchmark and legal approval.
