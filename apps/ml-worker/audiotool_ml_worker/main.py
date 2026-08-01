from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import math
import os
import re
import shutil
import sys
import time
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .vocal_breakdown import (
    MODEL_NAME as VOCAL_BREAKDOWN_MODEL,
    MODEL_VERSION as VOCAL_BREAKDOWN_VERSION,
    TARGETS as VOCAL_BREAKDOWN_TARGETS,
    create_vocal_breakdown,
    read_analysis,
)
from .texture_split import (
    HARMONIC_FILENAME,
    MODEL_NAME as TEXTURE_MODEL_NAME,
    MODEL_VERSION as TEXTURE_MODEL_VERSION,
    PERCUSSIVE_FILENAME,
    create_texture_split,
)
from .guide_tts import VOICE_BY_NAME, public_voice_profiles, synthesize_guide_speech

MODEL_NAME = os.getenv("AUDIOTOOL_ML_MODEL", "htdemucs_6s")
VOCAL_MODEL_NAME = os.getenv("AUDIOTOOL_ML_VOCAL_MODEL", "htdemucs_ft")
MODEL_VERSION = "demucs-4.1.0"
CACHE_ROOT = Path(os.getenv("AUDIOTOOL_ML_CACHE_ROOT", "./ml-cache")).resolve()
MAX_UPLOAD_BYTES = int(os.getenv("AUDIOTOOL_ML_MAX_UPLOAD_BYTES", str(524_288_000)))
CACHE_TTL_SECONDS = int(os.getenv("AUDIOTOOL_ML_CACHE_TTL_SECONDS", str(24 * 60 * 60)))
INFERENCE_TIMEOUT_SECONDS = int(os.getenv("AUDIOTOOL_ML_TIMEOUT_SECONDS", str(30 * 60)))
MODEL_SHIFTS = max(0, int(os.getenv("AUDIOTOOL_ML_SHIFTS", "0")))
CHECKSUM_PATTERN = re.compile(r"^[a-f0-9]{64}$")
INFERENCE_SEMAPHORE = asyncio.Semaphore(max(1, int(os.getenv("AUDIOTOOL_ML_CONCURRENCY", "1"))))
LOCKS: dict[str, asyncio.Lock] = {}

SOURCE_TO_LABEL = {
    "vocals": "vocals",
    "drums": "drums",
    "bass": "bass_guitar",
    "guitar": "guitar",
    "piano": "piano",
}
LABEL_TO_SOURCE = {label: source for source, label in SOURCE_TO_LABEL.items()} | {"other": "other"}
DERIVED_LABELS = {"instrumental": "instrumental"}
TEXTURE_LABELS = {
    "synthesizer": HARMONIC_FILENAME.removesuffix(".wav"),
    "percussion": PERCUSSIVE_FILENAME.removesuffix(".wav"),
}
DISPLAY_NAMES = {
    "vocals": "Vocals",
    "drums": "Drums",
    "bass_guitar": "Bass guitar",
    "guitar": "Guitar",
    "piano": "Piano",
    "other": "Other / residual",
    "synthesizer": "Synth / pads texture",
    "percussion": "Loops / percussion / FX texture",
}


class DetectedSpan(BaseModel):
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)


class Detection(BaseModel):
    canonicalLabel: str
    displayLabel: str
    confidence: float = Field(ge=0, le=1)
    detectedSpans: list[DetectedSpan]
    selected: bool
    manuallyAdded: bool = False
    modelName: str
    modelVersion: str


class DetectionResponse(BaseModel):
    detections: list[Detection]
    modelName: str
    modelVersion: str


class GuideSpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=160)
    voiceName: str
    speechRate: int = Field(default=0, ge=-5, le=5)


def _validate_checksum(value: str) -> str:
    normalized = value.strip().lower()
    if not CHECKSUM_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="X-Audio-Checksum must be a SHA-256 digest.")
    return normalized


async def _store_request(request: Request, checksum: str) -> Path:
    directory = CACHE_ROOT / checksum
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "source.audio"
    if destination.exists() and destination.stat().st_size > 0:
        async for _ in request.stream():
            pass
        os.utime(directory)
        return destination

    temporary = directory / "source.uploading"
    digest = hashlib.sha256()
    size = 0
    try:
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413, detail="Audio upload exceeds the worker limit."
                    )
                digest.update(chunk)
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Audio upload is empty.")
        if digest.hexdigest() != checksum:
            raise HTTPException(
                status_code=400, detail="Audio checksum does not match the request body."
            )
        temporary.replace(destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def _find_demucs_output(output_root: Path, source: str) -> Path:
    matches = list(output_root.rglob(f"{source}.wav"))
    if not matches:
        raise RuntimeError(f"Demucs did not create the expected {source} stem.")
    return matches[0]


def _model_sources(model_name: str) -> tuple[str, ...]:
    if model_name == "htdemucs_6s":
        return ("vocals", "drums", "bass", "guitar", "piano", "other")
    return ("vocals", "drums", "bass", "other")


def _model_directory(checksum: str, model_name: str) -> Path:
    source_directory = CACHE_ROOT / checksum
    if model_name == MODEL_NAME:
        return source_directory
    safe_model_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", model_name).strip("-")
    if not safe_model_name:
        raise RuntimeError("The configured vocal model name is invalid.")
    return source_directory / "models" / safe_model_name


def _cache_signature(model_name: str = MODEL_NAME) -> str:
    return f"{model_name}\n{MODEL_VERSION}\nshifts={MODEL_SHIFTS}\nderived=instrumental-v1\n"


def _cache_is_valid(completed: Path, model_name: str = MODEL_NAME) -> bool:
    try:
        return completed.read_text(encoding="utf-8") == _cache_signature(model_name)
    except OSError:
        return False


def _write_instrumental(directory: Path, sources: tuple[str, ...]) -> None:
    non_vocal_sources = [directory / f"{source}.wav" for source in sources if source != "vocals"]
    if not non_vocal_sources:
        raise RuntimeError("The selected model did not produce accompaniment sources.")
    destination = directory / "instrumental.wav"
    temporary = directory / "instrumental.creating.wav"
    temporary.unlink(missing_ok=True)
    try:
        with ExitStack() as stack:
            readers = [
                stack.enter_context(sf.SoundFile(path, mode="r")) for path in non_vocal_sources
            ]
            sample_rate = readers[0].samplerate
            channels = readers[0].channels
            if any(
                reader.samplerate != sample_rate or reader.channels != channels
                for reader in readers
            ):
                raise RuntimeError("Demucs accompaniment sources have incompatible audio formats.")
            writer = stack.enter_context(
                sf.SoundFile(
                    temporary,
                    mode="w",
                    samplerate=sample_rate,
                    channels=channels,
                    format="WAV",
                    subtype="FLOAT",
                )
            )
            while True:
                blocks = [
                    reader.read(131_072, dtype="float32", always_2d=True) for reader in readers
                ]
                frame_count = max((block.shape[0] for block in blocks), default=0)
                if frame_count == 0:
                    break
                mixed = np.zeros((frame_count, channels), dtype=np.float32)
                for block in blocks:
                    mixed[: block.shape[0]] += block
                writer.write(mixed)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


async def _run_demucs(checksum: str, source_path: Path, model_name: str = MODEL_NAME) -> Path:
    directory = _model_directory(checksum, model_name)
    directory.mkdir(parents=True, exist_ok=True)
    completed = directory / ".complete"
    if _cache_is_valid(completed, model_name) and (directory / "instrumental.wav").exists():
        return directory

    lock = LOCKS.setdefault(f"{checksum}:{model_name}", asyncio.Lock())
    async with lock:
        if _cache_is_valid(completed, model_name) and (directory / "instrumental.wav").exists():
            return directory
        if importlib.util.find_spec("demucs") is None:
            raise HTTPException(
                status_code=503, detail="Demucs is not installed in the ML worker environment."
            )

        raw_output = directory / "demucs-output"
        shutil.rmtree(raw_output, ignore_errors=True)
        raw_output.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            model_name,
            "--out",
            str(raw_output),
            "--float32",
            "--shifts",
            str(MODEL_SHIFTS),
            str(source_path),
        ]
        async with INFERENCE_SEMAPHORE:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=INFERENCE_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError as error:
                process.kill()
                await process.wait()
                raise HTTPException(
                    status_code=504, detail="Demucs inference timed out."
                ) from error
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace")[-1200:]
            raise HTTPException(status_code=502, detail=f"Demucs inference failed: {detail}")

        sources = _model_sources(model_name)
        for source in sources:
            separated = _find_demucs_output(raw_output, source)
            shutil.copyfile(separated, directory / f"{source}.wav")
        shutil.rmtree(raw_output, ignore_errors=True)
        await asyncio.to_thread(_write_instrumental, directory, sources)
        completed.write_text(_cache_signature(model_name), encoding="utf-8")
        return directory


def _texture_signature() -> str:
    return f"{TEXTURE_MODEL_NAME}\n{TEXTURE_MODEL_VERSION}\nsource=other.wav\n"


def _texture_cache_is_valid(directory: Path) -> bool:
    try:
        signature_matches = (directory / ".textures.complete").read_text(
            encoding="utf-8"
        ) == _texture_signature()
    except OSError:
        return False
    return signature_matches and all(
        (directory / f"{source}.wav").exists() for source in TEXTURE_LABELS.values()
    )


async def _run_texture_split(checksum: str, directory: Path) -> None:
    if _texture_cache_is_valid(directory):
        return
    source_path = directory / "other.wav"
    if not source_path.exists():
        raise HTTPException(
            status_code=422,
            detail="The configured separation model did not produce an Other stem.",
        )

    lock = LOCKS.setdefault(f"{checksum}:textures", asyncio.Lock())
    async with lock:
        if _texture_cache_is_valid(directory):
            return
        async with INFERENCE_SEMAPHORE:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(create_texture_split, source_path, directory),
                    timeout=INFERENCE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError as error:
                raise HTTPException(
                    status_code=504, detail="Residual texture analysis timed out."
                ) from error
            except (OSError, ValueError, RuntimeError) as error:
                raise HTTPException(
                    status_code=422, detail=f"Residual texture analysis failed: {error}"
                ) from error
        (directory / ".textures.complete").write_text(_texture_signature(), encoding="utf-8")


def _rms(path: Path) -> float:
    squared_sum = 0.0
    sample_count = 0
    for block in sf.blocks(path, blocksize=131_072, dtype="float32", always_2d=True):
        values = np.asarray(block, dtype=np.float64)
        squared_sum += float(np.sum(values * values))
        sample_count += int(values.size)
    return math.sqrt(squared_sum / max(1, sample_count))


def _detections(directory: Path, duration_ms: int) -> list[Detection]:
    energies = {source: _rms(directory / f"{source}.wav") for source in SOURCE_TO_LABEL}
    strongest = max(energies.values(), default=1e-9)
    candidates: list[tuple[str, float]] = []
    for source, label in SOURCE_TO_LABEL.items():
        rms = energies[source]
        relative = rms / max(strongest, 1e-9)
        decibels = 20 * math.log10(max(rms, 1e-9))
        confidence = max(0.05, min(0.99, 0.15 + relative * 0.75 + max(0, decibels + 60) / 600))
        if relative >= 0.04 and decibels >= -55:
            candidates.append((label, confidence))
    if not candidates and energies:
        strongest_source = max(energies, key=energies.get)  # type: ignore[arg-type]
        candidates.append((SOURCE_TO_LABEL[strongest_source], 0.35))
    candidates.sort(key=lambda item: item[1], reverse=True)
    detections = [
        Detection(
            canonicalLabel=label,
            displayLabel=DISPLAY_NAMES[label],
            confidence=round(confidence, 4),
            detectedSpans=[DetectedSpan(startMs=0, endMs=max(1, duration_ms))],
            selected=True,
            modelName=MODEL_NAME,
            modelVersion=MODEL_VERSION,
        )
        for label, confidence in candidates
    ]
    residual_rms = _rms(directory / "other.wav")
    residual_relative = residual_rms / max(strongest, 1e-9)
    residual_decibels = 20 * math.log10(max(residual_rms, 1e-9))
    if residual_relative >= 0.02 and residual_decibels >= -60:
        for label, source in TEXTURE_LABELS.items():
            rms = _rms(directory / f"{source}.wav")
            relative = rms / max(residual_rms, 1e-9)
            confidence = max(0.18, min(0.88, 0.3 + relative * 0.5))
            detections.append(
                Detection(
                    canonicalLabel=label,
                    displayLabel=DISPLAY_NAMES[label],
                    confidence=round(confidence, 4),
                    detectedSpans=[DetectedSpan(startMs=0, endMs=max(1, duration_ms))],
                    selected=True,
                    modelName=TEXTURE_MODEL_NAME,
                    modelVersion=TEXTURE_MODEL_VERSION,
                )
            )
    return detections


def _clean_expired_cache() -> None:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - CACHE_TTL_SECONDS
    for child in CACHE_ROOT.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue


async def _run_vocal_breakdown(checksum: str, source_path: Path) -> Path:
    directory = CACHE_ROOT / checksum / "vocal-breakdown"
    completed = directory / ".complete"
    signature = f"{VOCAL_BREAKDOWN_MODEL}\n{VOCAL_BREAKDOWN_VERSION}\n"
    try:
        valid = completed.read_text(encoding="utf-8") == signature
    except OSError:
        valid = False
    if valid and all((directory / f"{target}.wav").exists() for target in VOCAL_BREAKDOWN_TARGETS):
        return directory

    lock = LOCKS.setdefault(f"{checksum}:vocal-breakdown", asyncio.Lock())
    async with lock:
        try:
            valid = completed.read_text(encoding="utf-8") == signature
        except OSError:
            valid = False
        if valid and all(
            (directory / f"{target}.wav").exists() for target in VOCAL_BREAKDOWN_TARGETS
        ):
            return directory
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)
        async with INFERENCE_SEMAPHORE:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(create_vocal_breakdown, source_path, directory),
                    timeout=INFERENCE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError as error:
                raise HTTPException(
                    status_code=504, detail="Vocal breakdown analysis timed out."
                ) from error
            except (OSError, ValueError, RuntimeError) as error:
                raise HTTPException(
                    status_code=422, detail=f"Vocal breakdown failed: {error}"
                ) from error
        completed.write_text(signature, encoding="utf-8")
        return directory


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _clean_expired_cache()
    yield


app = FastAPI(
    title="AudioTool ML worker",
    version="0.1.0",
    description="Local real-provider adapter. It never silently falls back to mock separation.",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, object]:
    available = importlib.util.find_spec("demucs") is not None
    return {
        "status": "ready" if available else "missing_dependency",
        "backend": "demucs",
        "modelName": MODEL_NAME,
        "vocalModelName": VOCAL_MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "modelShifts": MODEL_SHIFTS,
        "available": available,
        "supportedLabels": [*LABEL_TO_SOURCE, *DERIVED_LABELS, *TEXTURE_LABELS],
    }


@app.get("/v1/info")
async def info() -> dict[str, object]:
    return {
        "provider": "demucs",
        "modelName": MODEL_NAME,
        "vocalModelName": VOCAL_MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "modelShifts": MODEL_SHIFTS,
        "supportedLabels": [*LABEL_TO_SOURCE, *DERIVED_LABELS, *TEXTURE_LABELS],
        "dynamicStemCount": True,
        "limitations": [
            "The bundled htdemucs_6s checkpoint exposes six source categories.",
            "Piano quality is experimental according to the model authors.",
            "Additional instrument families require another licensed checkpoint adapter.",
            "Quick vocal removal uses the fine-tuned vocal model and derives instrumental from all non-vocal sources.",
            "Synth/pads and loops/percussion/FX are a complementary sustained/transient split of the Other residual, not exact semantic instrument recognition.",
        ],
    }


@app.get("/v1/guide-voices")
async def guide_voices() -> dict[str, object]:
    return {
        "provider": "edge-neural",
        "voices": public_voice_profiles(),
    }


@app.post("/v1/guide-speech")
async def guide_speech(body: GuideSpeechRequest) -> Response:
    if body.voiceName not in VOICE_BY_NAME:
        raise HTTPException(status_code=422, detail="Unknown neural guide voice.")
    try:
        audio = await asyncio.wait_for(
            synthesize_guide_speech(body.text.strip(), body.voiceName, body.speechRate),
            timeout=60,
        )
    except asyncio.TimeoutError as error:
        raise HTTPException(status_code=504, detail="Neural guide speech timed out.") from error
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail=f"Neural guide speech failed: {error}"
        ) from error
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "X-AudioTool-Provider": "edge-neural",
            "X-AudioTool-Voice": body.voiceName,
        },
    )


@app.post("/v1/detect", response_model=DetectionResponse)
async def detect(
    request: Request,
    x_audio_checksum: str = Header(...),
    x_audio_duration_ms: int = Header(..., ge=1),
) -> DetectionResponse:
    checksum = _validate_checksum(x_audio_checksum)
    source = await _store_request(request, checksum)
    directory = await _run_demucs(checksum, source)
    await _run_texture_split(checksum, directory)
    return DetectionResponse(
        detections=await asyncio.to_thread(_detections, directory, x_audio_duration_ms),
        modelName=MODEL_NAME,
        modelVersion=MODEL_VERSION,
    )


@app.post("/v1/separate/{target_label}")
async def separate(
    target_label: str,
    request: Request,
    x_audio_checksum: str = Header(...),
    x_audiotool_separation_mode: str | None = Header(default=None),
) -> FileResponse:
    if (
        target_label not in LABEL_TO_SOURCE
        and target_label not in DERIVED_LABELS
        and target_label not in TEXTURE_LABELS
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Target {target_label!r} is not supported by {MODEL_NAME}.",
        )
    checksum = _validate_checksum(x_audio_checksum)
    source = await _store_request(request, checksum)
    use_vocal_model = x_audiotool_separation_mode == "quick" and target_label in {
        "vocals",
        "instrumental",
    }
    selected_model = VOCAL_MODEL_NAME if use_vocal_model else MODEL_NAME
    selected_sources = _model_sources(selected_model)
    source_name = DERIVED_LABELS.get(
        target_label,
        LABEL_TO_SOURCE.get(target_label, TEXTURE_LABELS.get(target_label)),
    )
    if source_name is None or (
        source_name != "instrumental"
        and target_label not in TEXTURE_LABELS
        and source_name not in selected_sources
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Target {target_label!r} is not supported by {selected_model}.",
        )
    directory = await _run_demucs(checksum, source, selected_model)
    if target_label in TEXTURE_LABELS:
        await _run_texture_split(checksum, directory)
    stem_path = directory / f"{source_name}.wav"
    if not stem_path.exists():
        raise HTTPException(
            status_code=500, detail="The requested stem is missing from the model output."
        )
    return FileResponse(
        path=stem_path,
        media_type="audio/wav",
        filename=f"{target_label}.wav",
        headers={
            "X-AudioTool-Provider": (
                "demucs-texture-split" if target_label in TEXTURE_LABELS else "demucs"
            ),
            "X-AudioTool-Model-Name": (
                TEXTURE_MODEL_NAME if target_label in TEXTURE_LABELS else selected_model
            ),
            "X-AudioTool-Model-Version": (
                TEXTURE_MODEL_VERSION if target_label in TEXTURE_LABELS else MODEL_VERSION
            ),
        },
    )


@app.post("/v1/vocal-breakdown/analyze")
async def analyze_vocals(
    request: Request,
    x_audio_checksum: str = Header(...),
) -> dict[str, object]:
    checksum = _validate_checksum(x_audio_checksum)
    source = await _store_request(request, checksum)
    directory = await _run_vocal_breakdown(checksum, source)
    return read_analysis(directory)


@app.post("/v1/vocal-breakdown/{target}")
async def vocal_breakdown_target(
    target: str,
    request: Request,
    x_audio_checksum: str = Header(...),
) -> FileResponse:
    if target not in VOCAL_BREAKDOWN_TARGETS:
        raise HTTPException(status_code=422, detail=f"Unknown vocal breakdown target {target!r}.")
    checksum = _validate_checksum(x_audio_checksum)
    source = await _store_request(request, checksum)
    directory = await _run_vocal_breakdown(checksum, source)
    analysis = read_analysis(directory)
    coverage = (
        1.0
        if target == "melody"
        else next(
            (float(item["coverage"]) for item in analysis["registers"] if item["part"] == target),
            0.0,
        )
    )
    confidence = (
        float(analysis["confidence"])
        if target == "melody"
        else next(
            (float(item["confidence"]) for item in analysis["registers"] if item["part"] == target),
            0.0,
        )
    )
    return FileResponse(
        path=directory / f"{target}.wav",
        media_type="audio/wav",
        filename=f"vocal-{target}.wav",
        headers={
            "X-AudioTool-Provider": "local-pitch-analysis",
            "X-AudioTool-Model-Name": VOCAL_BREAKDOWN_MODEL,
            "X-AudioTool-Model-Version": VOCAL_BREAKDOWN_VERSION,
            "X-AudioTool-Coverage": str(coverage),
            "X-AudioTool-Confidence": str(confidence),
        },
    )
