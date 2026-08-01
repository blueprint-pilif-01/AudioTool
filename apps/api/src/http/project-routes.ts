import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createProjectSchema, updateProjectSchema } from "@audiotool/contracts";
import { projects } from "@audiotool/database";

import { notFound } from "../errors.js";
import { serializeProject } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });

export function registerProjectRoutes(app: FastifyInstance, context: ApiContext) {
  app.post("/api/projects", async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const [project] = await context.db.insert(projects).values(body).returning();
    if (!project) throw new Error("Project insert did not return a row.");
    return reply.status(201).send({ project: serializeProject(project) });
  });

  app.get("/api/projects", async () => {
    const rows = await context.db
      .select()
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(desc(projects.updatedAt));
    return { projects: rows.map(serializeProject) };
  });

  app.get("/api/projects/:projectId", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const [project] = await context.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw notFound("Project");
    return { project: serializeProject(project) };
  });

  app.patch("/api/projects/:projectId", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const body = updateProjectSchema.parse(request.body);
    const [project] = await context.db
      .update(projects)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .returning();
    if (!project) throw notFound("Project");
    return { project: serializeProject(project) };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const [project] = await context.db
      .update(projects)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .returning({ id: projects.id });
    if (!project) throw notFound("Project");
    return reply.status(204).send();
  });
}
