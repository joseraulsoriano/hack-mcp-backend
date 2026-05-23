import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";

export async function getTenantBySlug(slug: string) {
  const [row] = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function requireTenantBySlug(slug: string) {
  const t = await getTenantBySlug(slug);
  if (!t) throw new Error(`tenant '${slug}' no existe`);
  return t;
}
