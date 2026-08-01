import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type Stats } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { fileTypeFromFile } from "file-type";

import { AppError } from "../errors.js";

const acceptedExtensions = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".webm"]);
const acceptedMimeTypes = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "video/webm",
]);

export interface StoredUpload {
  storageKey: string;
  absolutePath: string;
  originalFilename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface AudioStorageService {
  readonly providerName: string;
  initialize(): Promise<void>;
  storeUpload(
    projectId: string,
    filename: string,
    declaredMimeType: string,
    stream: NodeJS.ReadableStream,
  ): Promise<StoredUpload>;
  createOutputPath(
    projectId: string,
    label: string,
    extension?: string,
  ): Promise<{ storageKey: string; absolutePath: string }>;
  resolveKey(storageKey: string): string;
  createReadStream(storageKey: string, range?: { start: number; end: number }): ReadStream;
  stat(storageKey: string): Promise<Stats>;
  remove(storageKey: string): Promise<void>;
  cleanupTemporaryFiles(olderThan: Date): Promise<number>;
}

export class LocalStorageService implements AudioStorageService {
  public readonly providerName = "local";

  public constructor(
    private readonly root: string,
    private readonly tempRoot: string,
    private readonly maxUploadBytes: number,
  ) {}

  public async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.tempRoot, { recursive: true }),
    ]);
  }

  public async storeUpload(
    projectId: string,
    filename: string,
    declaredMimeType: string,
    stream: NodeJS.ReadableStream,
  ): Promise<StoredUpload> {
    const safeOriginalName = basename(filename).slice(0, 255);
    const originalExtension = extname(safeOriginalName).toLowerCase();
    if (!acceptedExtensions.has(originalExtension)) {
      throw new AppError(
        415,
        "UNSUPPORTED_AUDIO_FORMAT",
        "This audio file extension is not supported.",
      );
    }

    const temporaryPath = resolve(this.tempRoot, `${randomUUID()}.upload`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
      if (sizeBytes > this.maxUploadBytes && "destroy" in stream) {
        (stream as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(
          new AppError(413, "UPLOAD_TOO_LARGE", "The uploaded audio file exceeds the size limit."),
        );
      }
    });

    try {
      await pipeline(stream, createWriteStream(temporaryPath, { flags: "wx" }));
      if (sizeBytes === 0) throw new AppError(400, "EMPTY_UPLOAD", "The uploaded file is empty.");

      const detected = await fileTypeFromFile(temporaryPath);
      const detectedMime = detected?.mime ?? declaredMimeType.toLowerCase();
      if (!acceptedMimeTypes.has(detectedMime) && !detectedMime.startsWith("audio/")) {
        throw new AppError(
          415,
          "INVALID_AUDIO_FILE",
          "The uploaded file is not recognized as audio.",
        );
      }

      const extension = detected?.ext ? `.${detected.ext.toLowerCase()}` : originalExtension;
      const storageKey = `${projectId}/${randomUUID()}${extension}`;
      const destination = this.resolveKey(storageKey);
      await mkdir(resolve(destination, ".."), { recursive: true });
      try {
        await rename(temporaryPath, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw error;
        await copyFile(temporaryPath, destination);
        await rm(temporaryPath, { force: true });
      }

      return {
        storageKey,
        absolutePath: destination,
        originalFilename: safeOriginalName,
        extension,
        mimeType: detectedMime,
        sizeBytes,
        checksumSha256: hash.digest("hex"),
      };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  public async createOutputPath(
    projectId: string,
    label: string,
    extension = ".wav",
  ): Promise<{ storageKey: string; absolutePath: string }> {
    const safeLabel = label
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]+/g, "-")
      .slice(0, 60);
    const storageKey = `${projectId}/${safeLabel}-${randomUUID()}${extension}`;
    const absolutePath = this.resolveKey(storageKey);
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    return { storageKey, absolutePath };
  }

  public resolveKey(storageKey: string): string {
    const resolvedRoot = resolve(this.root);
    const resolvedPath = resolve(resolvedRoot, storageKey);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
      throw new AppError(400, "INVALID_STORAGE_KEY", "Invalid storage path.");
    }
    return resolvedPath;
  }

  public createReadStream(storageKey: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolveKey(storageKey), range);
  }

  public async stat(storageKey: string) {
    return stat(this.resolveKey(storageKey));
  }

  public async remove(storageKey: string): Promise<void> {
    await rm(this.resolveKey(storageKey), { force: true });
  }

  public async cleanupTemporaryFiles(olderThan: Date): Promise<number> {
    const entries = await readdir(this.tempRoot, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(this.tempRoot, entry.name);
      const fileStats = await stat(path).catch(() => null);
      if (!fileStats || fileStats.mtime >= olderThan) continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }
}
