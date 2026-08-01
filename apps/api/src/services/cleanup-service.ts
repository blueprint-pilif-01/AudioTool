import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import {
  audioAssets,
  mixSessions,
  projects,
  stems,
  type AudioToolDatabase,
} from "@audiotool/database";

import type { AudioStorageService } from "./storage.js";

interface CleanupServiceOptions {
  db: AudioToolDatabase;
  storage: AudioStorageService;
  logger: FastifyBaseLogger;
  tempFileTtlHours: number;
  projectRetentionDays: number;
  intervalMinutes: number;
}

export class CleanupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(private readonly options: CleanupServiceOptions) {}

  public start(): void {
    if (this.timer) return;
    void this.run().catch((error: unknown) => {
      this.options.logger.error({ err: error }, "Scheduled cleanup failed");
    });
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Scheduled cleanup failed");
      });
    }, this.options.intervalMinutes * 60_000);
    this.timer.unref();
  }

  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async run(): Promise<{ temporaryFiles: number; expiredProjects: number }> {
    if (this.running) return { temporaryFiles: 0, expiredProjects: 0 };
    this.running = true;
    try {
      const temporaryCutoff = new Date(Date.now() - this.options.tempFileTtlHours * 60 * 60 * 1000);
      const temporaryFiles = await this.options.storage.cleanupTemporaryFiles(temporaryCutoff);
      let expiredProjects = 0;
      if (this.options.projectRetentionDays > 0) {
        const projectCutoff = new Date(
          Date.now() - this.options.projectRetentionDays * 24 * 60 * 60 * 1000,
        );
        const expired = await this.options.db
          .select({ id: projects.id })
          .from(projects)
          .where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, projectCutoff)))
          .limit(50);
        for (const project of expired) {
          const assets = await this.options.db
            .select({ storageKey: audioAssets.storageKey })
            .from(audioAssets)
            .where(eq(audioAssets.projectId, project.id));
          const deleted = await this.options.db.transaction(async (tx) => {
            await tx
              .update(projects)
              .set({ sourceAudioId: null })
              .where(
                and(
                  eq(projects.id, project.id),
                  isNotNull(projects.deletedAt),
                  lt(projects.deletedAt, projectCutoff),
                ),
              );
            await tx.delete(mixSessions).where(eq(mixSessions.projectId, project.id));
            await tx.delete(stems).where(eq(stems.projectId, project.id));
            await tx.delete(audioAssets).where(eq(audioAssets.projectId, project.id));
            return tx
              .delete(projects)
              .where(
                and(
                  eq(projects.id, project.id),
                  isNotNull(projects.deletedAt),
                  lt(projects.deletedAt, projectCutoff),
                ),
              )
              .returning({ id: projects.id });
          });
          if (deleted.length === 0) continue;
          expiredProjects += 1;
          const removals = await Promise.allSettled(
            assets.map((asset) => this.options.storage.remove(asset.storageKey)),
          );
          const failures = removals.filter((result) => result.status === "rejected").length;
          if (failures > 0) {
            this.options.logger.warn(
              { projectId: project.id, failures },
              "Expired project metadata was removed but some storage objects remain",
            );
          }
        }
      }
      if (temporaryFiles > 0 || expiredProjects > 0) {
        this.options.logger.info(
          { temporaryFiles, expiredProjects },
          "AudioTool cleanup completed",
        );
      }
      return { temporaryFiles, expiredProjects };
    } finally {
      this.running = false;
    }
  }
}
