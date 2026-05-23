import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "./client.ts";

async function main() {
  console.log("[migrate] aplicando migraciones desde ./drizzle");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] ok");
  await sqlClient.end();
}

main().catch((err) => {
  console.error("[migrate] error", err);
  process.exit(1);
});
