import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { audioAssets, projects, separationJobs, stems, users } from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import type { ApiContext } from "../http/types.js";

export interface AudioToolIdentity {
  userId: string;
  externalUserId: string;
  role: "user" | "admin";
}

function deterministicUserUuid(externalUserId: string) {
  const bytes = createHash("sha256").update(`biserica-vertical:${externalUserId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeKeyMatch(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function oneHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function ensureInternalUser(request: FastifyRequest, context: ApiContext) {
  const externalUserId = oneHeader(request, "x-audiotool-user-id");
  if (!externalUserId || !/^[1-9]\d{0,18}$/.test(externalUserId)) {
    throw new AppError(401, "IDENTITY_REQUIRED", "A valid internal user identity is required.");
  }
  const requestedRole = oneHeader(request, "x-audiotool-user-role");
  const role: AudioToolIdentity["role"] = requestedRole === "admin" ? "admin" : "user";
  const encodedDisplayName = oneHeader(request, "x-audiotool-user-name");
  let displayName = `Biserica user ${externalUserId}`;
  if (encodedDisplayName) {
    try {
      displayName = decodeURIComponent(encodedDisplayName).trim().slice(0, 160) || displayName;
    } catch {
      // Use the stable fallback if a proxy changed the encoded display name.
    }
  }
  const userId = deterministicUserUuid(externalUserId);
  await context.db
    .insert(users)
    .values({
      id: userId,
      email: `biserica-${externalUserId}@internal.invalid`,
      displayName,
      role,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName, role, updatedAt: new Date() },
    });
  request.audioToolIdentity = { userId, externalUserId, role };
}

async function assertResourceOwnership(request: FastifyRequest, context: ApiContext) {
  const identity = request.audioToolIdentity;
  if (!identity) throw new AppError(401, "IDENTITY_REQUIRED", "Authentication is required.");
  const params = (request.params || {}) as Record<string, unknown>;
  const projectId = typeof params.projectId === "string" ? params.projectId : null;
  const assetId = typeof params.assetId === "string" ? params.assetId : null;
  const jobId = typeof params.jobId === "string" ? params.jobId : null;
  const stemId = typeof params.stemId === "string" ? params.stemId : null;

  let owner: { userId: string | null; projectId: string } | undefined;
  if (projectId) {
    [owner] = await context.db
      .select({ userId: projects.userId, projectId: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
  } else if (assetId) {
    [owner] = await context.db
      .select({ userId: projects.userId, projectId: projects.id })
      .from(audioAssets)
      .innerJoin(projects, eq(projects.id, audioAssets.projectId))
      .where(and(eq(audioAssets.id, assetId), isNull(audioAssets.deletedAt), isNull(projects.deletedAt)))
      .limit(1);
  } else if (jobId) {
    [owner] = await context.db
      .select({ userId: projects.userId, projectId: projects.id })
      .from(separationJobs)
      .innerJoin(projects, eq(projects.id, separationJobs.projectId))
      .where(and(eq(separationJobs.id, jobId), isNull(projects.deletedAt)))
      .limit(1);
  } else if (stemId) {
    [owner] = await context.db
      .select({ userId: projects.userId, projectId: projects.id })
      .from(stems)
      .innerJoin(projects, eq(projects.id, stems.projectId))
      .where(and(eq(stems.id, stemId), isNull(projects.deletedAt)))
      .limit(1);
  }

  if ((projectId || assetId || jobId || stemId) && !owner) {
    throw notFound("Resource");
  }
  if (owner?.userId && owner.userId !== identity.userId) {
    throw notFound("Resource");
  }
  if (owner && !owner.userId) {
    await context.db
      .update(projects)
      .set({ userId: identity.userId, updatedAt: new Date() })
      .where(and(eq(projects.id, owner.projectId), isNull(projects.userId)));
  }
}

export function registerInternalAuthentication(app: FastifyInstance, context: ApiContext) {
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS") return;
    const pathname = request.url.split("?", 1)[0];
    if (pathname === "/health" || pathname === "/ready") return;
    if (context.config.NODE_ENV !== "production" && pathname?.startsWith("/docs")) return;

    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer\s+([^\s]+)$/i.exec(authorization) : null;
    if (!match || !safeKeyMatch(match[1]!, context.config.INTERNAL_API_KEY)) {
      throw new AppError(401, "UNAUTHORIZED", "A valid internal service credential is required.");
    }
    await ensureInternalUser(request, context);
  });

  app.addHook("preHandler", async (request) => {
    if (request.method === "OPTIONS") return;
    const pathname = request.url.split("?", 1)[0];
    if (pathname === "/health" || pathname === "/ready") return;
    if (context.config.NODE_ENV !== "production" && pathname?.startsWith("/docs")) return;
    await assertResourceOwnership(request, context);
  });
}

declare module "fastify" {
  interface FastifyRequest {
    audioToolIdentity?: AudioToolIdentity;
  }
}
