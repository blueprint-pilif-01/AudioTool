import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(resource: string): AppError {
  return new AppError(404, "NOT_FOUND", `${resource} was not found.`);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | AppError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ZodError) {
        void reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "The request contains invalid data.",
            requestId: request.id,
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
        return;
      }

      if ("code" in error && error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
        void reply.status(400).send({
          error: {
            code: "EMPTY_JSON_BODY",
            message: "The request body is missing. Refresh the page and try again.",
            requestId: request.id,
          },
        });
        return;
      }

      if (error instanceof AppError) {
        void reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
        return;
      }

      request.log.error({ err: error }, "Unhandled request error");
      const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
      void reply.status(statusCode).send({
        error: {
          code: statusCode < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR",
          message: statusCode < 500 ? error.message : "An unexpected server error occurred.",
          requestId: request.id,
        },
      });
    },
  );
}
