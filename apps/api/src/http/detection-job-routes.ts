import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createSeparationJobSchema,
  instrumentDetectionSchema,
  instrumentLabelSchema,
  updateDetectionsSchema,
  type SeparationMode,
} from "@audiotool/contracts";
import { instrumentDetections, projects, separationJobs } from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import { serializeJob } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const jobParams = z.object({ jobId: z.string().uuid() });
const recentJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(8),
});
const retryJobSchema = z.object({
  detectionIds: z.array(z.string().uuid()).min(1).optional(),
  canonicalLabels: z.array(instrumentLabelSchema).min(1).optional(),
});

const activeJobStatuses = ["queued", "detecting", "separating", "rendering"] as const;

async function createOrReuseProcessingJob(
  context: ApiContext,
  input: {
    projectId: string;
    userId: string;
    mode: SeparationMode;
    task: "detect" | "separate" | "render";
    options: Record<string, unknown>;
  },
) {
  return context.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.projectId}))`);
    const [project] = await tx
      .select({ id: projects.id, sourceAudioId: projects.sourceAudioId, status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw notFound("Project");
    if (!project.sourceAudioId) {
      throw new AppError(409, "SOURCE_AUDIO_REQUIRED", "Upload a source audio file first.");
    }

    const activeJobs = await tx
      .select()
      .from(separationJobs)
      .where(
        and(
          eq(separationJobs.projectId, input.projectId),
          inArray(separationJobs.status, activeJobStatuses),
        ),
      )
      .orderBy(desc(separationJobs.queuedAt));
    const matchingJob = activeJobs.find((job) => job.options.task === input.task);
    if (matchingJob) return { job: matchingJob, reused: true };
    if (activeJobs[0]) {
      const task = activeJobs[0].options.task;
      const taskName = typeof task === "string" ? task : "processing";
      throw new AppError(
        409,
        "PROJECT_JOB_ALREADY_RUNNING",
        `This project already has an active ${taskName} job.`,
      );
    }
    const userActiveJobs = await tx
      .select({ id: separationJobs.id })
      .from(separationJobs)
      .innerJoin(projects, eq(projects.id, separationJobs.projectId))
      .where(
        and(
          eq(projects.userId, input.userId),
          isNull(projects.deletedAt),
          inArray(separationJobs.status, activeJobStatuses),
        ),
      );
    if (userActiveJobs.length >= context.config.MAX_CONCURRENT_JOBS_PER_USER) {
      throw new AppError(429, "CONCURRENT_JOB_QUOTA_EXCEEDED", "Another audio job is already running.");
    }
    if (input.task === "detect" && project.status === "awaiting_confirmation") {
      const [completedDetection] = await tx
        .select()
        .from(separationJobs)
        .where(
          and(
            eq(separationJobs.projectId, input.projectId),
            eq(separationJobs.status, "awaiting_confirmation"),
          ),
        )
        .orderBy(desc(separationJobs.queuedAt))
        .limit(1);
      if (completedDetection?.options.task === "detect") {
        return { job: completedDetection, reused: true };
      }
    }

    const [job] = await tx
      .insert(separationJobs)
      .values({
        projectId: input.projectId,
        mode: input.mode,
        status: "queued",
        progress: 0,
        currentStage: "queued",
        provider: context.provider.name,
        options: { ...input.options, task: input.task },
      })
      .returning();
    if (!job) throw new Error("Processing job insert did not return a row.");
    return { job, reused: false };
  });
}

export function registerDetectionAndJobRoutes(app: FastifyInstance, context: ApiContext) {
  app.post("/api/projects/:projectId/detect-instruments", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const { job, reused } = await createOrReuseProcessingJob(context, {
      projectId,
      userId: request.audioToolIdentity!.userId,
      mode: "auto",
      task: "detect",
      options: {},
    });
    if (!reused) await context.jobProcessor.enqueue(job.id);
    return reply.status(202).send({ job: serializeJob(job) });
  });

  app.get("/api/projects/:projectId/detections", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const rows = await context.db
      .select()
      .from(instrumentDetections)
      .where(eq(instrumentDetections.projectId, projectId))
      .orderBy(asc(instrumentDetections.createdAt));
    return {
      detections: rows.map((row) =>
        instrumentDetectionSchema.parse({
          id: row.id,
          canonicalLabel: row.canonicalLabel,
          displayLabel: row.displayLabel,
          confidence: row.confidence,
          detectedSpans: row.detectedSpans,
          selected: row.selected,
          manuallyAdded: row.manuallyAdded,
          modelName: row.modelName,
          modelVersion: row.modelVersion,
        }),
      ),
    };
  });

  app.patch("/api/projects/:projectId/detections", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const body = updateDetectionsSchema.parse(request.body);
    const rows = await context.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(instrumentDetections)
        .where(eq(instrumentDetections.projectId, projectId));
      const existingById = new Map(existing.map((detection) => [detection.id, detection]));
      const existingByLabel = new Map(
        existing.map((detection) => [detection.canonicalLabel, detection]),
      );
      await tx.delete(instrumentDetections).where(eq(instrumentDetections.projectId, projectId));
      return tx
        .insert(instrumentDetections)
        .values(
          body.detections.map((detection) => {
            const original =
              (detection.id ? existingById.get(detection.id) : undefined) ??
              existingByLabel.get(detection.canonicalLabel);
            return {
              projectId,
              canonicalLabel: detection.canonicalLabel,
              displayLabel: detection.displayLabel,
              confidence: detection.confidence,
              detectedSpans: detection.manuallyAdded ? [] : (original?.detectedSpans ?? []),
              selected: detection.selected,
              manuallyAdded: detection.manuallyAdded,
              modelName: detection.manuallyAdded
                ? "manual"
                : (original?.modelName ?? context.provider.modelName),
              modelVersion: detection.manuallyAdded
                ? "user"
                : (original?.modelVersion ?? context.provider.modelVersion),
            };
          }),
        )
        .returning();
    });
    return {
      detections: rows.map((row) => ({
        id: row.id,
        canonicalLabel: row.canonicalLabel,
        displayLabel: row.displayLabel,
        confidence: row.confidence,
        detectedSpans: row.detectedSpans,
        selected: row.selected,
        manuallyAdded: row.manuallyAdded,
        modelName: row.modelName,
        modelVersion: row.modelVersion,
      })),
    };
  });

  app.post("/api/projects/:projectId/separation-jobs", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createSeparationJobSchema.parse(request.body ?? {});
    const { job, reused } = await createOrReuseProcessingJob(context, {
      projectId,
      userId: request.audioToolIdentity!.userId,
      mode: body.mode,
      task: "separate",
      options: {
        ...(body.detectionIds ? { detectionIds: body.detectionIds } : {}),
      },
    });
    if (!reused) await context.jobProcessor.enqueue(job.id);
    return reply.status(202).send({ job: serializeJob(job) });
  });

  app.get("/api/projects/:projectId/jobs", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const rows = await context.db
      .select()
      .from(separationJobs)
      .where(eq(separationJobs.projectId, projectId))
      .orderBy(desc(separationJobs.queuedAt));
    return { jobs: rows.map(serializeJob) };
  });

  app.get("/api/jobs", async (request) => {
    const { limit } = recentJobsQuery.parse(request.query);
    const rows = await context.db
      .select({
        job: separationJobs,
        projectName: projects.name,
        projectStatus: projects.status,
      })
      .from(separationJobs)
      .innerJoin(projects, eq(separationJobs.projectId, projects.id))
      .where(
        and(
          or(eq(projects.userId, request.audioToolIdentity!.userId), isNull(projects.userId)),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(separationJobs.queuedAt))
      .limit(limit);
    return {
      jobs: rows.map((row) => ({
        ...serializeJob(row.job),
        projectName: row.projectName,
        projectStatus: row.projectStatus,
      })),
    };
  });

  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = jobParams.parse(request.params);
    const [job] = await context.db
      .select()
      .from(separationJobs)
      .where(eq(separationJobs.id, jobId))
      .limit(1);
    if (!job) throw notFound("Job");
    return { job: serializeJob(job) };
  });

  app.post("/api/jobs/:jobId/cancel", async (request, reply) => {
    const { jobId } = jobParams.parse(request.params);
    await context.jobProcessor.cancel(jobId);
    return reply.status(202).send({ accepted: true });
  });

  app.post("/api/jobs/:jobId/retry", async (request, reply) => {
    const { jobId } = jobParams.parse(request.params);
    const body = retryJobSchema.parse(request.body ?? {});
    const [existing] = await context.db
      .select()
      .from(separationJobs)
      .where(eq(separationJobs.id, jobId))
      .limit(1);
    if (!existing) throw notFound("Job");
    if (existing.status !== "failed" && existing.status !== "cancelled") {
      throw new AppError(409, "JOB_NOT_RETRYABLE", "Only failed or cancelled jobs can be retried.");
    }
    const task =
      existing.options.task === "detect" ||
      existing.options.task === "render" ||
      existing.options.task === "separate"
        ? existing.options.task
        : "separate";
    const { job, reused } = await createOrReuseProcessingJob(context, {
      projectId: existing.projectId,
      userId: request.audioToolIdentity!.userId,
      mode: existing.mode,
      task,
      options: {
        ...existing.options,
        retryOf: existing.id,
        partialRetry: Boolean(body.detectionIds?.length || body.canonicalLabels?.length),
        ...(body.detectionIds ? { detectionIds: body.detectionIds } : {}),
        ...(body.canonicalLabels ? { canonicalLabels: body.canonicalLabels } : {}),
      },
    });
    if (!reused) await context.jobProcessor.enqueue(job.id);
    return reply.status(202).send({ job: serializeJob(job) });
  });

  app.get("/api/jobs/:jobId/events", async (request, reply) => {
    const { jobId } = jobParams.parse(request.params);
    const [job] = await context.db
      .select()
      .from(separationJobs)
      .where(eq(separationJobs.id, jobId))
      .limit(1);
    if (!job) throw notFound("Job");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: unknown) => {
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    };
    send({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.currentStage ?? job.status,
      message: "Connected to job progress.",
      timestamp: new Date().toISOString(),
    });
    const unsubscribe = context.eventHub.subscribe(jobId, send);
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
