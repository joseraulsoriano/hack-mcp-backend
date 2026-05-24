import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ ERROR: DATABASE_URL is not defined in environment variables.");
  process.exit(1);
}

const maskedUrl = DATABASE_URL.replace(/:([^@]+)@/, ":****@");
console.log(`[db] conectando a ${maskedUrl}`);

/**
 * Single connection pool reused by repos, MCP server y scripts CLI.
 * `max: 10` es suficiente para hack; subimos cuando escale.
 */
export const sqlClient = postgres(DATABASE_URL, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sqlClient, { schema });

export type DB = typeof db;
export { schema };
