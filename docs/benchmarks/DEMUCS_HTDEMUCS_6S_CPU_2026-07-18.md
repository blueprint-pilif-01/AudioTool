# Demucs `htdemucs_6s` real-provider benchmark

Run date: 2026-07-18 (Europe/Bucharest)

## Scope and provenance

This is the first real-provider vertical slice required after the mock milestone. The benchmark
uses an 18-second stereo WAV synthesized at runtime by `apps/ml-worker/benchmark_demucs.py`. It
contains three labelled six-second scenes:

1. rhythm, bass, and voice-like harmonics;
2. bass, guitar-like plucks, and piano-like chords;
3. a dense mix containing all six checkpoint targets.

No third-party or commercial recording is used. All reference stems and the mixture are generated
from project code with a fixed random seed. The generated audio and estimates remain in the ignored
`apps/ml-worker/benchmark-output` directory.

## Exact runtime

| Item                          | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Provider                      | Demucs HTTP worker                                                 |
| Model                         | `htdemucs_6s`                                                      |
| Demucs                        | `4.1.0`                                                            |
| PyTorch                       | `2.13.0+cpu`                                                       |
| Python                        | `3.13.2`                                                           |
| Device                        | CPU, 16 logical cores                                              |
| OS                            | Windows 11 AMD64                                                   |
| Model shifts                  | `0` for deterministic inference                                    |
| Checkpoint                    | `5c90dfd2.safetensors`, 54,885,744 bytes                           |
| Checkpoint SHA-256            | `d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411` |
| Cache-miss inference          | 12.326 seconds                                                     |
| Real-time factor              | 0.685                                                              |
| Relative reconstruction error | -23.192 dB                                                         |

The checkpoint was already present on disk for the timed run; the worker's per-audio inference
cache was removed. Download latency is therefore excluded. Two independent cache-miss runs emitted
byte-identical stem files when `modelShifts=0`.

## Global quality measurements

| Label       | Reference RMS dBFS | Estimate RMS dBFS | SI-SDR dB | SI-SDR improvement dB |
| ----------- | -----------------: | ----------------: | --------: | --------------------: |
| vocals      |            -23.454 |           -64.340 |   -13.174 |                -8.213 |
| drums       |            -28.481 |           -28.533 |    18.914 |                30.808 |
| bass guitar |            -19.546 |           -19.533 |    24.130 |                22.764 |
| guitar      |            -34.444 |           -64.417 |   -38.494 |               -25.416 |
| piano       |            -33.417 |           -31.017 |     1.262 |                14.159 |
| other       |            -30.558 |           -22.812 |    -7.782 |                 4.190 |

Energy-based detection selected `bass_guitar`, `drums`, and `piano`. It did not select the
synthetic voice or guitar timbres. This is an honest failure on this corpus, not a reason to adjust
the fixture until the model looks better.

The reconstruction check did not meet the current -30 dB review threshold. AudioTool preserves the
output and records a warning so the user can inspect the residual.

## Determinism evidence

The following hashes were identical across two fresh inference-cache runs:

| Stem        | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| bass guitar | `78d82cd278859e2da6a45a9fb43cd12e9bb6a73176de04d5771abe43884943b5` |
| drums       | `7d3e3e8f8caba3073dae94ac820f2ce3bb8b95a7fa2375e34682fa298edeb249` |
| guitar      | `da49ecdb8b472f3feb47068294838e245bfb8533fb89169c354e02cc99070802` |
| other       | `113709dbb11dfe10f52123b0cc1f8e5e21cf58a700b05df45b46120f91733a81` |
| piano       | `fe582b65910687e394145344310cfd490d6062ac4d4f4eb30e73f6491a675f64` |
| vocals      | `48979b7c55073743cda734ac6cec0f6364c22ddd15d0fb6987e3e8ae04b718f4` |

## End-to-end integration evidence

The opt-in test `apps/api/src/real-provider.integration.test.ts` ran the same checkpoint through:

```text
Vue/Node contract -> Fastify project API -> PostgreSQL job state ->
Demucs HTTP worker -> persisted stems -> residual -> mixer
```

It verified provider capabilities, upload, real detection, confirmation without losing exact model
metadata, separation, residual creation, and persisted `mock: false` processing metadata. The test
project and temporary storage were removed after the run.

## Interpretation and release decision

- The vertical slice is technically integrated and reproducible on this CPU.
- Bass and drums separate well on the synthetic fixture; piano improves over the mixture.
- Synthetic vocals and guitar perform poorly, so this result is not a general quality claim.
- `htdemucs_6s` remains limited to vocals, drums, bass, guitar, piano, and other.
- The default application configuration remains `ML_PROVIDER=mock`. Enabling the real provider is
  an explicit local choice.
- Demucs code is MIT. The downloaded checkpoint needs a separate provenance/commercial-use review;
  this benchmark does not resolve that legal question.

Official references: [Demucs 4.1.0 on PyPI](https://pypi.org/project/demucs/),
[maintained Demucs source](https://github.com/adefossez/demucs), and
[archived Meta repository](https://github.com/facebookresearch/demucs).
