import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase } from "./index.js";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and add your pgAdmin credentials.",
  );
}

const { db, pool } = createDatabase(databaseUrl);

try {
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  console.info("AudioTool migrations applied successfully.");
} finally {
  await pool.end();
}
