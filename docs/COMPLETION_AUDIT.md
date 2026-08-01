# AudioTool completion audit

Audit date: 2026-07-18

This document maps the implementation to `MASTER_PROMPT.md`. It deliberately distinguishes verified behavior from provider contracts and future production work.

## Executive status

- **First milestone: accepted locally.** All 13 acceptance criteria are implemented and covered by the current local test run.
- **Product tools: implemented.** Dynamic project workflow, mixer, quick separator, pitch/tempo, key/BPM, cutter, and joiner are available in the Vue application.
- **Real-provider vertical slice: verified.** Demucs 4.1.0 with `htdemucs_6s` and the quick-mode `htdemucs_ft` profile is installed in an isolated local environment, benchmarked on project-generated synthetic audio, and covered through Fastify/PostgreSQL by an opt-in integration test. `.env.example` remains mock-by-default; the current ignored local `.env` deliberately selects `demucs_http`.
- **Fine-grained universal ML: not claimed.** Demucs exposes six categories. Banquet, SAM-Audio, and AudioSep workers/checkpoints are not installed, and no current model can honestly separate every label in the dynamic taxonomy.
- **Production infrastructure: partially prepared.** The storage boundary, Redis/BullMQ mode, cleanup, Docker services, and configuration are present. A concrete S3/R2/MinIO implementation, authentication, quotas, and production deployment hardening remain future work.

## First milestone acceptance

| #   | Requirement                                         | Status | Evidence                                                                                                      |
| --- | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | Starts locally from README                          | Pass   | `pnpm dev`; web at `http://localhost:5173`, API at `http://127.0.0.1:3000`                                    |
| 2   | API connects to `audio_tool` through `DATABASE_URL` | Pass   | `/ready` reports `postgres.ok: true`; integration tests use the configured PostgreSQL instance                |
| 3   | Non-destructive migrations                          | Pass   | Drizzle migration in `packages/database/drizzle`; no drop/reset workflow; database URL is required explicitly |
| 4   | Create project and upload audio                     | Pass   | API integration and Playwright workflow tests                                                                 |
| 5   | Extract and persist metadata                        | Pass   | FFprobe-backed upload route; integration assertions for the stored asset                                      |
| 6   | Mock detects a dynamic instrument list              | Pass   | Mock integration flow produces more than four canonical instrument categories                                 |
| 7   | User can edit selection                             | Pass   | Instrument confirmation UI and API update covered by E2E/integration tests                                    |
| 8   | Asynchronous mock separation produces labeled stems | Pass   | Job dispatcher/processor and integration test                                                                 |
| 9   | Real-time progress                                  | Pass   | SSE job event stream and workflow E2E                                                                         |
| 10  | Mixer includes play, mute, solo, volume             | Pass   | Dynamic mixer E2E on desktop and mobile                                                                       |
| 11  | Project and mixer persist after refresh             | Pass   | Mixer save/reload assertion in E2E and API integration                                                        |
| 12  | Tests, typecheck, and build pass                    | Pass   | Verification record below                                                                                     |
| 13  | README distinguishes mock from real ML              | Pass   | README and `docs/IMPLEMENTATION_STATUS.md`                                                                    |

## Functional requirements

### Projects and audio assets

**Implemented:** project create/list/rename/controlled deletion; drag-and-drop upload; WAV, MP3, FLAC, M4A/AAC, OGG, and WebM validation; size and duration limits; SHA-256 integrity and same-project deduplication; FFprobe metadata; UUID storage names; safe path handling; local storage through `AudioStorageService`; configurable retention cleanup.

**Boundary only:** S3/R2/MinIO can be added behind `AudioStorageService`, but no production object-storage driver is included yet.

### Detection and separation

**Implemented:** stable detection and separation contracts; canonical label normalization; confidence, spans, model/version metadata; editable include/exclude/manual selection; dynamic stem count; residual stem; asynchronous jobs; SSE; cancellation; guarded state transitions; targeted retry for only the failed instrument; provider selection from configuration; reconstruction-error measurement; mock provider for deterministic development and tests.

**Available provider profiles:** `demucs_http`, `banquet_http`, `sam_audio_http`, and `audiosep_http` use the same checked HTTP contract. The Python Demucs worker is installed and verified on CPU in this workspace. The API exposes provider/model/version/supported-label capabilities, and the UI prevents an unsupported label from being submitted to an active real provider.

**Verified real slice:** a cache-miss 18-second Demucs inference completed in 12.326 seconds on CPU (real-time factor 0.685). Two independent runs emitted byte-identical stem hashes with shifts disabled. The worker and Node API persisted exact `htdemucs_6s` / `demucs-4.1.0` metadata and `mock: false`. Full results are in `docs/benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md`.

**Verified vocal-remover correction:** quick mode now passes its separation profile to the worker, uses `htdemucs_ft`, and derives `instrumental` from every non-vocal source. A real cache-miss Fastify/PostgreSQL run produced exactly `vocals` and `instrumental`, both persisted with `htdemucs_ft`, `demucs-4.1.0`, and `mock: false`. The former mock behavior—two quieter copies of the full mix—is no longer active in the local runtime.

**Not claimed:** fine-grained separation for every detected category still requires compatible, licensed query-conditioned workers/checkpoints. Demucs alone is a fallback for common classes and cannot honestly provide arbitrary per-instrument separation. Its checkpoint also needs a separate commercial-use/provenance decision.

### Mixer

**Implemented:** one waveform track per dynamic stem; synchronized play/pause/stop/seek/playhead; mute, solo, volume, pan, and reset; clip positioning; trim; fades; remove/restore; master volume and limiter; per-track and master level meters; zoom; individual stem download; ZIP download; persisted mix session; backend reproducible WAV/MP3/FLAC mix rendering.

The browser preview uses Web Audio APIs. Backend FFmpeg remains the source of reproducible rendered output.

### Quick separation

**Implemented:** vocal/instrumental quick mode, common-stem mode, and auto-detect dynamic mode share the project/job/result infrastructure.

The checked-in example remains mock-safe for first-run development. The current local runtime is
explicitly connected to Demucs; existing stems created by older mock jobs are not rewritten
retroactively and must be regenerated.

### Pitch, tempo, key, and BPM

**Implemented:** audio-signal key/scale/BPM analysis; confidence and analysis duration; half/double-time candidates; multi-file batch; CSV/JSON export; handoff into Pitch & Tempo; independent semitone and tempo controls; original/result values; preview and WAV export.

The DSP boundary is `PitchTempoAdapter`, currently implemented by FFmpeg resampling plus `atempo`. License considerations are recorded in `docs/THIRD_PARTY_LICENSES.md`.

### Cutter

**Implemented:** waveform selection, multiple precise regions, keep/remove operation, fades, local sequence preview, backend rendered preview, and WAV/MP3/FLAC export.

### Joiner

**Implemented:** multiple files, drag-and-drop and accessible button reordering, per-file trim, direct/pause/crossfade transitions, optional -16 LUFS normalization, rendered preview, and WAV/MP3/FLAC export.

### History, errors, and observability

**Implemented:** project workspace plus a dedicated recent-job feed backed by PostgreSQL, explicit job states, safe public errors, structured Fastify logging with request/job context, liveness/readiness endpoints, Swagger/OpenAPI at `/docs` and `/docs/json`, temporary-file cleanup, and soft-deleted-project retention cleanup.

**Configuration-dependent:** readiness reports the active queue. In local inline mode it reports `queue: inline`; Redis connectivity is relevant and checked by BullMQ only when Redis mode is selected. A standalone Redis health result is therefore not shown in the current inline configuration.

## Data, API, and security

- Drizzle schema covers projects, audio assets, detections, jobs, stems, mix sessions/tracks, analysis results, and processing events.
- Audio bytes stay outside PostgreSQL.
- Upload and FFmpeg operations pass user data as arguments rather than constructing shell command strings.
- The real database password is stored only in the ignored `.env`; `.env.example` contains placeholders.
- Project deletion is soft first. Scheduled hard cleanup uses an explicit foreign-key-safe order and only affects expired soft-deleted projects.
- Groq is intentionally absent from the critical path and no audio is sent to a third party.
- Commercial recordings are not stored as test fixtures; tests generate short synthetic audio.

Production authentication, authorization, ownership isolation, rate limiting, quotas, malware scanning, remote storage, and deployment secrets management are not part of this local milestone.

## Verification record

The final local verification produced these results:

```text
pnpm lint                               -> passed
pnpm typecheck                          -> passed across all TypeScript/Vue packages
pnpm build                              -> passed
pnpm db:migrate                         -> passed (idempotent on configured audio_tool)
pnpm format:check                       -> passed
pnpm test                               -> 4 API + 10 audio-engine + 6 contract tests passed
pnpm test:e2e                           -> 16/16 desktop and mobile tests passed
pytest apps/ml-worker/tests             -> 5 passed
ruff check + format --check             -> passed
real-provider API integration           -> 1/1 passed; dynamic htdemucs_6s + quick htdemucs_ft
Demucs deterministic CPU benchmark      -> passed; quality limits recorded
docker compose ... config --quiet       -> passed
GET /docs/json                          -> 200 application/json
GET /ready (current local API)          -> ready
  postgres                              -> ok
  ffmpeg                                -> ok
  storage                               -> ok
  ml                                    -> htdemucs_6s / demucs-4.1.0, ok
  queue                                 -> inline, ok
GET /health (ML worker)                 -> ready; htdemucs_6s + htdemucs_ft
```

The integration suite uses a generated sine-wave fixture and a dedicated test project lifecycle. It verifies upload/deduplication, dynamic detection, edited selection, separation plus residual, reconstruction metadata, mixer persistence, cancellation rules, targeted retry, and controlled project deletion.

The project workspace integration also verifies the global recent-job endpoint, its project name/status metadata, and newest-first bounded result. The E2E suite exercises the same feed on desktop and mobile. API integration renders actual MP3 and FLAC mix files in addition to the WAV-capable path.

## Remaining work before claiming real universal separation or public production readiness

1. Resolve commercial rights/provenance for the selected checkpoint separately from the MIT code.
2. Install and benchmark a licensed query-conditioned provider for labels beyond Demucs's six outputs.
3. Run blinded listening, detection, leakage, and GPU/VRAM measurements on an authorized representative music corpus.
4. Add a production object-storage implementation and production security controls before public deployment.

The requested real-provider vertical slice is complete. Until the remaining steps are complete, the application is not a claim of perfect real separation for every instrument or of production/commercial readiness.
