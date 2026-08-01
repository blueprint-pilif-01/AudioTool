import type { FastifyBaseLogger } from "fastify";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import type { JobProcessor } from "./job-processor.js";

export interface JobDispatcher {
  enqueue(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  checkHealth(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export class InlineJobDispatcher implements JobDispatcher {
  public constructor(private readonly processor: JobProcessor) {}

  public enqueue(jobId: string): Promise<void> {
    this.processor.enqueue(jobId);
    return Promise.resolve();
  }

  public async cancel(jobId: string): Promise<void> {
    await this.processor.cancel(jobId);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public checkHealth(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: "inline" });
  }
}

interface QueuePayload {
  jobId: string;
}

export class BullMqJobDispatcher implements JobDispatcher {
  private readonly queueConnection: Redis;
  private readonly workerConnection: Redis;
  private readonly queue: Queue<QueuePayload>;
  private readonly worker: Worker<QueuePayload>;

  public constructor(
    redisUrl: string,
    private readonly processor: JobProcessor,
    logger: FastifyBaseLogger,
  ) {
    this.queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<QueuePayload>("audiotool-processing", {
      connection: this.queueConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400, count: 5000 },
      },
    });
    this.worker = new Worker<QueuePayload>(
      "audiotool-processing",
      async (job) => this.processor.process(job.data.jobId),
      {
        connection: this.workerConnection,
        concurrency: 1,
        lockDuration: 10 * 60 * 1000,
      },
    );
    this.worker.on("failed", (job, error) => {
      logger.error({ err: error, queueJobId: job?.id }, "BullMQ audio job failed");
    });
    this.worker.on("error", (error) => {
      logger.error({ err: error }, "BullMQ worker connection error");
    });
  }

  public async enqueue(jobId: string): Promise<void> {
    await this.queue.add("process", { jobId }, { jobId });
  }

  public async cancel(jobId: string): Promise<void> {
    const queued = await this.queue.getJob(jobId);
    if (queued) {
      const state = await queued.getState();
      if (state !== "active") await queued.remove();
    }
    await this.processor.cancel(jobId);
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await Promise.allSettled([this.queueConnection.quit(), this.workerConnection.quit()]);
  }

  public async checkHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.queueConnection.ping();
      return { ok: response === "PONG", detail: "bullmq/redis" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Redis unavailable",
      };
    }
  }
}
