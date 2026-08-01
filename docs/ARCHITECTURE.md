# Architecture

## Runtime boundaries

```text
Vue browser
  | REST + SSE + ranged audio
Fastify API
  |-- PostgreSQL: metadata, jobs, detections, mixer state
  |-- local storage: source audio, stems, renders
  |-- inline runner or BullMQ/Redis: asynchronous orchestration
  |-- FFmpeg/ffprobe: decode, metadata, tools, final render
  `-- provider contract
        |-- deterministic mock
        `-- streamed HTTP -> FastAPI/Demucs worker
```

Node owns the product state and never performs heavy DSP on its event loop. FFmpeg and the Python
worker run out of process. The browser handles interactive preview only; the saved mix is rendered
again on the backend for reproducibility.

## Dynamic stem model

An `instrument_detection` is a proposed category and may be renamed, selected, excluded, or added
manually. A separation job resolves those rows into any number of target stem records. `other` is
added when absent. Mixer tracks reference stored audio assets, not a hardcoded vocals/drums/bass
object. `canonical_label` plus `instance_index` leaves room for future instance separation.

## State flow

```text
draft -> uploaded -> analyzing -> awaiting_confirmation
      -> separating -> ready
      -> rendering -> ready

job: queued -> detecting/awaiting_confirmation
job: queued -> separating/rendering -> completed
                               `-----> failed/cancelled
```

Transitions and results are written transactionally where a project, job, stems, and mix session
must agree. Every progress update is also a `processing_events` row and an SSE event.

## Storage boundary

PostgreSQL contains only metadata and object keys. The API depends on `AudioStorageService`;
`LocalStorageService` is its implemented development driver and resolves every key below a
configured root while rejecting path traversal. Internal filenames are UUID-based. A future object
storage implementation must materialize a secure local work file for FFmpeg and upload results
atomically; `STORAGE_DRIVER=s3` remains reserved rather than silently falling back to local disk.

## Provider boundary

The Node provider contract exposes detection, single-target separation, health, model identity, and
cancellation. The HTTP adapter streams bytes with a checksum rather than sharing host paths. Model
choice is configuration (`mock`, `demucs_http`, `banquet_http`, `sam_audio_http`, or
`audiosep_http`), not a UI hardcode.

Demucs is the current real vertical slice. The named query-conditioned adapters expose the same
contract but require a separately installed, licensed, and benchmarked compatible worker. Stem
metadata records target query, model identity, elapsed time, mock status, and the job stores a
measured reconstruction error when a full separation finishes.
