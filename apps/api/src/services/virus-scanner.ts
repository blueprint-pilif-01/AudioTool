import { spawn } from "node:child_process";

import type { AppConfig } from "@audiotool/config";

import { AppError } from "../errors.js";

export interface VirusScanner {
  scan(filePath: string): Promise<void>;
}

export class DisabledVirusScanner implements VirusScanner {
  async scan(): Promise<void> {
    return Promise.resolve();
  }
}

export class ClamAvVirusScanner implements VirusScanner {
  public constructor(
    private readonly executable: string,
    private readonly timeoutMs: number,
  ) {}

  async scan(filePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, ["--no-summary", "--infected", "--", filePath], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk.slice(0, 16_384 - stdout.length);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk.slice(0, 16_384 - stderr.length);
      });
      child.once("error", (cause) => {
        clearTimeout(timer);
        reject(new AppError(503, "VIRUS_SCANNER_UNAVAILABLE", "File scanning is temporarily unavailable.", cause));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        if (code === 1) {
          return reject(new AppError(422, "FILE_REJECTED", "The uploaded file failed the malware scan."));
        }
        return reject(
          new AppError(
            503,
            "VIRUS_SCANNER_FAILED",
            "The uploaded file could not be scanned.",
            new Error(`${stdout}\n${stderr}`.trim()),
          ),
        );
      });
    });
  }
}

export function createVirusScanner(config: AppConfig): VirusScanner {
  return config.VIRUS_SCAN_MODE === "clamav"
    ? new ClamAvVirusScanner(config.CLAMSCAN_PATH, config.VIRUS_SCAN_TIMEOUT_MS)
    : new DisabledVirusScanner();
}
