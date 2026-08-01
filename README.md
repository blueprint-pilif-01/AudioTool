# AudioTool

AudioTool is a local-first audio workspace built with Vue 3, TypeScript, Fastify, PostgreSQL,
BullMQ, FFmpeg, and an optional Python ML worker. Its main workflow is:

`Upload -> Analyze -> Confirm instruments -> Separate -> Mix / Download`

The project does **not** assume a fixed four-stem layout. Detection rows, jobs, stems, database
records, API DTOs, and mixer tracks are dynamic. The explicit development mock currently returns
six detected categories plus `Other / residual`, so the complete UI flow can be developed and
tested without a GPU.

## What works now

| Area                         | Implementation                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and uploads         | Real PostgreSQL persistence, multipart upload, MIME/extension/duration checks, SHA-256 deduplication, `ffprobe` metadata, range streaming      |
| Instrument workflow          | Dynamic shared contracts, editable labels and selection, confidence display, manual additions                                                  |
| Development separation       | Deterministic mock, clearly labelled as mock; produces valid WAV files for UI and automated tests                                              |
| Real-provider vertical slice | Optional FastAPI + Demucs `htdemucs_6s` worker with checksum cache and streamed transfer                                                       |
| Jobs                         | Inline development runner or BullMQ/Redis, guarded state transitions, cancellation, targeted stem retry, persisted events, SSE progress        |
| Mixer                        | Web Audio playback, synchronized seek, waveform, mute/solo, level/pan, trim/fades, clip drag, meters, zoom, remove/restore, save/reload/export |
| Render                       | Asynchronous reproducible WAV/MP3/FLAC mix through FFmpeg, limiter included                                                                    |
| Audio tools                  | Batch key/BPM with CSV/JSON, independent pitch/tempo preview, multi-region cutter, trimmed/normalized joiner, WAV/MP3/FLAC                     |
| API docs                     | Swagger UI at `http://localhost:3000/docs`                                                                                                     |

The Demucs checkpoint has only six output classes: vocals, drums, bass, guitar, piano, and other.
It must not be described as a universal arbitrary-instrument separator. The architecture accepts
more labels, but brass, strings, woodwinds, vocal subtypes, and other fine categories require a
query-conditioned provider/checkpoint and evaluation before they can be enabled as real outputs.

See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for the exact boundary between
the first milestone and later production work.

## Prerequisites

- Node.js 22+
- pnpm 11+
- PostgreSQL 18 with the existing `audio_tool` database
- FFmpeg and ffprobe available on `PATH`
- Optional: Docker Desktop for Redis and MinIO
- Optional real ML: Python 3.11 or 3.12, PyTorch, and preferably an NVIDIA GPU

Python 3.14 is fine for unrelated tooling, but Python 3.11/3.12 is recommended for the broadest
PyTorch/Demucs wheel support.

## First local start on Windows

1. Install JavaScript dependencies:

   ```powershell
   pnpm install
   ```

2. Create the local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit only the credentials in `DATABASE_URL` so they match the PostgreSQL login configured in
   pgAdmin. Keep the database name as `audio_tool`:

   ```env
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/audio_tool
   ```

4. Apply the versioned migration to that configured database:

   ```powershell
   pnpm db:migrate
   ```

   The migration creates application tables and indexes. It does not create/drop the database,
   drop schemas, or reset unrelated data. Always inspect `DATABASE_URL` before running it.

5. Start the Vue and Fastify development servers:

   ```powershell
   pnpm dev
   ```

6. Open `http://localhost:5173`. The API is on `http://localhost:3000`.

The default values use `QUEUE_MODE=inline`, `ML_PROVIDER=mock`, and local disk storage, so Redis,
Docker, Python, CUDA, and model downloads are not needed for the first run.

## Optional Redis and MinIO

From the repository root:

```powershell
docker compose -f infra/compose.yaml up -d redis minio minio-init
```

Then set `QUEUE_MODE=bullmq`. MinIO is provisioned for the future S3-compatible implementation.
The API already depends on an `AudioStorageService` contract, while milestone one intentionally
uses its local driver. Do not set `STORAGE_DRIVER=s3` until an S3/R2/MinIO implementation is added
and tested.

The optional Compose PostgreSQL service is deliberately behind a profile and maps host port 5433,
so it does not replace the PostgreSQL 18 instance or `audio_tool` database already managed in
pgAdmin:

```powershell
docker compose -f infra/compose.yaml --profile isolated-postgres up -d postgres
```

Inside a container, the Windows host is `host.docker.internal`, not `localhost`. An API container
that must reach the existing host database would therefore use a URL such as
`postgresql://USER:PASSWORD@host.docker.internal:5432/audio_tool`.

## Optional real Demucs provider

Follow [apps/ml-worker/README.md](apps/ml-worker/README.md), then change:

```env
ML_PROVIDER=demucs_http
ML_WORKER_URL=http://localhost:8000
ML_REQUEST_TIMEOUT_MS=1800000
```

The first Demucs inference downloads model weights. The verified local CPU slice used Python
3.13.2, PyTorch 2.13.0, and Demucs 4.1.0. Its reproducible synthetic benchmark and quality limits
are recorded in
[docs/benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md](docs/benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md).
The dynamic splitter uses `htdemucs_6s`. Vocal remover uses the fine-tuned `htdemucs_ft` profile
and creates the instrumental output by summing all non-vocal sources, matching Demucs's two-stem
workflow rather than copying or filtering the original mix. The fine-tuned profile can take about
four times as long as the base model on CPU.
The 30-minute API timeout is intentional for long CPU-only tracks; keep it at least as high as the
worker's `AUDIOTOOL_ML_TIMEOUT_SECONDS` value.
GPU memory requirements still depend on track duration, segment settings, PyTorch/CUDA versions,
and the selected model.

Docker users can start the isolated CPU worker and persistent model cache with:

```powershell
docker compose -f infra/compose.yaml --profile real-ml up -d ml-worker
```

`banquet_http`, `sam_audio_http`, and `audiosep_http` are selectable transport adapters for workers
that implement the same stable HTTP contract. They do not install a checkpoint or pretend that the
bundled Demucs worker supports those models.

## Groq

Groq is useful as an **optional** service for vocal transcription, word/segment timestamps,
translation, or natural-language UI commands. It is not a music source-separation engine and is
not used for detection or stem generation here. Audio must never be uploaded to Groq without an
explicit user action and consent. The core application has no Groq dependency.

## Commands

```text
pnpm install        install workspace dependencies
pnpm db:generate    generate a Drizzle migration after schema changes
pnpm db:migrate     apply pending migrations to DATABASE_URL
pnpm dev            start API and web development servers
pnpm lint           run ESLint
pnpm typecheck      run strict TypeScript checks
pnpm test           run unit tests and the opt-in PostgreSQL integration suite
pnpm test:e2e       run desktop and mobile Playwright workflow tests
pnpm build          build every TypeScript/Vue package
```

The API integration suite uses `TEST_DATABASE_URL` and skips if it is absent. Give it a disposable
database, never the pgAdmin database containing valuable data:

```powershell
$env:TEST_DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/audio_tool_test"
pnpm --filter @audiotool/api test
```

## Repository layout

```text
apps/web             Vue 3 application
apps/api             Fastify API, jobs, storage, providers
apps/ml-worker       optional Python/Demucs provider
packages/contracts   Zod DTOs and shared types
packages/database    Drizzle schema and migrations
packages/audio-engine safe FFmpeg builders and local DSP analysis
packages/config      validated environment configuration
infra                Compose and container definitions
docs                 architecture, security, model and license notes
```

Audio files live under the configured storage directory, never in PostgreSQL. Secrets belong only
in `.env`, which is ignored by source control.
