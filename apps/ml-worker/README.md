# AudioTool ML worker

This service is the optional real-provider vertical slice. The Node API uses it only when
`ML_PROVIDER=demucs_http`; otherwise the explicit deterministic mock provider remains active.

The built-in adapter runs Demucs `htdemucs_6s`, caches the six generated sources by the uploaded
SHA-256 checksum, and turns measured stem energy into an instrument-presence estimate. The Node
service still owns project state, job state, storage metadata, and the mixer.

## Local setup

Python 3.11 through 3.13 is supported by the currently pinned packages. The verified local run used
Python 3.13.2 and PyTorch 2.13.0 CPU. Keep the ML environment isolated from the Node workspace.

```powershell
cd apps/ml-worker
py -3.13 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .
python -m uvicorn audiotool_ml_worker.main:app --host 127.0.0.1 --port 8000
```

The first inference downloads the configured Demucs checkpoints. `AUDIOTOOL_ML_MODEL` defaults to
`htdemucs_6s` for dynamic instrument separation, while `AUDIOTOOL_ML_VOCAL_MODEL` defaults to the
fine-tuned `htdemucs_ft` for the two-output Vocal remover. In quick mode, `instrumental.wav` is
derived by summing every non-vocal source; it is never a filtered or quieter copy of the original
mix. Set `AUDIOTOOL_ML_CACHE_ROOT`, `AUDIOTOOL_ML_TIMEOUT_SECONDS`, and
`AUDIOTOOL_ML_SHIFTS` to override the remaining defaults. Zero shifts makes output deterministic;
higher values trade more compute for equivariant stabilization. GPU use follows the PyTorch
installation in this virtual environment.

### CPU and GPU memory modes

- The verified workspace uses CPU-only PyTorch and does not require CUDA. It is slower than a
  compatible GPU, but it is the safe fallback when CUDA or sufficient VRAM is unavailable.
- [Demucs's current upstream guidance](https://pypi.org/project/demucs/) is **about 7 GB VRAM with
  default arguments**, with **3 GB as a minimum only when shorter segments are configured** (which
  can reduce quality). Plan on at
  least 7 GB VRAM for this worker's default model settings; measure the exact deployed checkpoint
  and track duration before setting production concurrency.
- Install a CUDA-enabled PyTorch wheel matching the host driver to enable GPU inference. The worker
  selects CUDA automatically when PyTorch reports it available. One inference is allowed per
  worker; scale concurrency only after VRAM measurements to avoid out-of-memory failures.
- `ML_PROVIDER=mock` remains the zero-model development/test mode. It never loads a checkpoint and
  is labeled as mock in persisted metadata and the UI.

The upstream memory numbers are model guidance, not a measurement from this machine; no compatible
GPU was present during the recorded benchmark.

## Reproduce the local benchmark

With the worker running on port 8000:

```powershell
.venv\Scripts\python.exe benchmark_demucs.py
.venv\Scripts\python.exe -m pytest tests -q
.venv\Scripts\python.exe -m ruff check .
```

The benchmark synthesizes its own authorized fixture and writes ignored audio/results to
`benchmark-output`. The recorded 2026-07-18 result is in
`docs/benchmarks/DEMUCS_HTDEMUCS_6S_CPU_2026-07-18.md`.

## Honest capability boundary

`htdemucs_6s` supports vocals, drums, bass, guitar, piano, and other. It does not provide a separate
checkpoint output for brass, woodwinds, strings, percussion, lead/backing vocals, acoustic/electric
guitar, or synth subcategories. AudioTool's database, contracts, jobs, and mixer accept a dynamic
number of labels, but a new checkpoint adapter is required before those extra categories can be
claimed as real separation.

No uploaded audio is forwarded to a third party by this service.
