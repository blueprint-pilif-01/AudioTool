# Implementation status

This document prevents mock behavior and roadmap items from being confused with validated product
capabilities.

## Milestone one

- Project CRUD, soft deletion, validated audio upload, duration limits, SHA-256 deduplication,
  metadata, and range streaming are real.
- PostgreSQL schema and the first non-destructive Drizzle migration are present.
- Dynamic instrument detections can be edited, selected, excluded, or manually added.
- Job state and processing events are persisted; guarded transitions, cancellation, targeted stem
  retry, and SSE progress are implemented.
- Inline jobs work without Redis. BullMQ is selectable for a single-concurrency worker.
- Mock detection/separation is deterministic and explicitly stored as `mock: true`.
- Full separation jobs record target/model/elapsed metadata and measure reconstruction error against
  the original mix.
- The mixer uses browser audio, saves track/master settings to PostgreSQL, and supports synchronized
  transport, clip drag, trim, fades, mute/solo, pan, reset, remove/restore, meters, master limiting,
  and timeline zoom.
- ZIP stem download and asynchronous backend WAV/MP3/FLAC mix rendering are implemented.
- Key/BPM batch analysis includes confidence, half/double-time candidates, CSV/JSON, and handoff to
  Pitch & Tempo.
- Pitch/tempo uses a documented FFmpeg adapter, renders a preview, and changes pitch independently
  from tempo.
- Cutter supports multiple keep/remove regions, local sequence preview, fades, rendered preview,
  and WAV/MP3/FLAC output.
- Joiner supports drag ordering, per-file trim, direct/pause/crossfade transitions, optional
  normalization, rendered preview, and WAV/MP3/FLAC output.
- Configurable cleanup removes stale temporary files and purges only soft-deleted projects older
  than the retention window.
- The Projects workspace includes a bounded, newest-first PostgreSQL feed for recent detection,
  separation, and render jobs with status, progress, and links back to the correct workflow stage.
- Desktop and mobile E2E tests cover the dynamic seven-track mixer and all four auxiliary audio tool
  workflows.

## Real ML vertical slice

The optional HTTP provider and Python worker run Demucs `htdemucs_6s` for dynamic instrument
separation and `htdemucs_ft` for the focused Vocal remover. It caches inference output by source
SHA-256 and model. Quick-mode instrumental audio is the block-wise sum of all non-vocal model
sources, not a gain-adjusted copy of the original. The dynamic provider taxonomy is still limited
to vocals, drums, bass, guitar, piano, other, and the derived instrumental output.

The current workspace has an isolated Python 3.13 environment, Demucs 4.1.0, PyTorch 2.13.0 CPU,
and checkpoints `htdemucs_6s` plus `htdemucs_ft`. A deterministic synthetic benchmark and a real
Fastify/PostgreSQL integration test covering both dynamic and two-stem separation have passed. See
`benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md`. The result exposes weak synthetic vocals/guitar
performance and is not a production-quality or commercial-license claim.

The real quick-mode integration proves exact `htdemucs_ft` metadata and two outputs (`vocals` and
`instrumental`). It is a functional pipeline check, not a listening-quality claim for every genre.

The API exposes `/api/ml/capabilities`. The instrument-confirmation UI shows the active model and
prevents an unsupported manually added label from being submitted to the current real provider.
Detection confirmation preserves the exact worker model/version instead of replacing it with a
transport placeholder.

## Intentionally not claimed as complete

- Installed Banquet/SAM-Audio/AudioSep workers and their checkpoints. Named HTTP adapters exist,
  but never fall back to Demucs or mock results.
- True fine-grained real separation for every detected instrument.
- S3/R2/MinIO storage implementation; the adapter contract and local driver are implemented.
- Authentication, accounts, quotas, billing, antivirus scanning, and production rate limits.
- Per-instance separation such as two electric guitars or lead/backing vocals.
- A GPU benchmark and listening test on an authorized representative music corpus. The completed
  CPU benchmark uses project-generated synthetic audio.
- Groq integration. No file is sent to Groq by the current code.

These are explicit deployment/model roadmap items, not hidden buttons or simulated outputs.
