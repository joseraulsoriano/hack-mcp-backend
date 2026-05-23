import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://hack:hack@localhost:5433/hack",
  },
  strict: true,
  verbose: true,
} satisfies Config;
