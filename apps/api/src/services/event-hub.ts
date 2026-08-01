import { EventEmitter } from "node:events";

import type { JobEventPayload } from "@audiotool/contracts";

export class JobEventHub {
  private readonly emitter = new EventEmitter();

  public publish(event: JobEventPayload): void {
    this.emitter.emit(event.jobId, event);
  }

  public subscribe(jobId: string, listener: (event: JobEventPayload) => void): () => void {
    this.emitter.on(jobId, listener);
    return () => {
      this.emitter.off(jobId, listener);
    };
  }
}
