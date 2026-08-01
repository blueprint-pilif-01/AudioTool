import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type AudioToolDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export * from "./schema.js";
