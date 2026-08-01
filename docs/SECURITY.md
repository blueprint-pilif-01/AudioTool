# Security notes

## Implemented controls

- Environment-only credentials and Zod configuration validation.
- UUID internal storage names; original names are metadata only.
- Extension, MIME, magic-byte, size, audio-stream, and duration validation.
- SHA-256 integrity metadata for uploads and model transfer.
- Canonical storage-root checks to prevent path traversal.
- FFmpeg is spawned with an argument array and `shell: false`; user input is never concatenated into
  a shell command.
- Upload/body limits, explicit CORS origin, hidden internal paths in API errors, request IDs, and
  structured logs.
- Soft project deletion and no destructive database migration operations.
- No implicit third-party upload. Mock and local providers work offline.

## Required before public deployment

- Authentication and project ownership checks on every resource.
- CSRF strategy if cookie authentication is added; secure, HttpOnly, SameSite cookies.
- Per-user upload/job quotas, rate limiting, queue admission control, and storage budgets.
- Malware scanning and a sandboxed media-processing environment with CPU/memory/time limits.
- Private object storage, short-lived signed URLs, encryption, backups, retention, and deletion jobs.
- Network isolation between API, Redis, PostgreSQL, and ML workers; TLS and secret management.
- Dependency/model provenance scanning and a documented incident-response path.
- Consent records before any Groq or other third-party processing.

Never run integration tests against a database that contains valuable data. Never expose Swagger
or readiness error detail publicly without access controls.
