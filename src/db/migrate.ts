import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "./client.ts";

/**
 * Aplica las extensiones requeridas (idempotente) y luego las migraciones
 * Drizzle. En local con docker-compose, esto ya lo hace `scripts/init.sql`,
 * pero en Railway/Supabase/Vercel-PG el plugin no corre init scripts, asi que
 * lo hacemos en codigo. Sin esto, la primera migracion falla al referenciar
 * tipos vector / pg_trgm.
 */
async function main() {
  console.log("[migrate] preparando extensiones (vector, pg_trgm, uuid-ossp)");
  try {
    await sqlClient`CREATE EXTENSION IF NOT EXISTS vector`;
    await sqlClient`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    await sqlClient`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
  } catch (e) {
    console.warn("[migrate] aviso al crear extensiones (posible falta de permisos):", (e as Error).message);
  }
  console.log("[migrate] aplicando migraciones desde ./drizzle");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] ok");
  await sqlClient.end();
}

main().catch((err) => {
  console.error("[migrate] error", err);
  process.exit(1);
});
