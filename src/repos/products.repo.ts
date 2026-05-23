import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";

export async function listProducts(tenantId: string) {
  return db
    .select({
      id: schema.products.id,
      slug: schema.products.slug,
      name: schema.products.name,
      summary: schema.products.summary,
      pricing: schema.products.pricing,
    })
    .from(schema.products)
    .where(eq(schema.products.tenantId, tenantId))
    .orderBy(schema.products.name);
}

export async function getProductBySlug(tenantId: string, slug: string) {
  const [row] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function getProductById(tenantId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
    .limit(1);
  return row ?? null;
}
