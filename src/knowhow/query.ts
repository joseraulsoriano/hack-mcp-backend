import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { embedOne, embeddingsEnabled } from "./embed.ts";

export interface KnowhowQueryInput {
  tenantId: string;
  productId?: string | null;
  query: string;
  k?: number;
}

export interface KnowhowChunk {
  id: string;
  productId: string | null;
  text: string;
  score: number;
  strategy: "vector" | "trigram";
}

/**
 * Estrategia dual:
 *   1. Si hay OPENAI_API_KEY -> embedding de la query + cosine distance (`<=>`) con pgvector.
 *   2. Si no -> ranking por similitud trigram (`similarity()`), barato y sin API.
 *
 * Esto permite arrancar HOY sin API key y subir calidad cuando se conecte.
 */
export async function queryKnowhow(input: KnowhowQueryInput): Promise<KnowhowChunk[]> {
  const { tenantId, productId, query, k = 5 } = input;
  if (!query.trim()) return [];

  if (embeddingsEnabled()) {
    const vec = await embedOne(query);
    if (vec) return vectorSearch(tenantId, productId ?? null, vec, k);
  }

  return trigramSearch(tenantId, productId ?? null, query, k);
}

async function vectorSearch(
  tenantId: string,
  productId: string | null,
  vec: number[],
  k: number,
): Promise<KnowhowChunk[]> {
  const vecLiteral = sql.raw(`'[${vec.join(",")}]'::vector`);
  const distance = sql<number>`(${schema.knowhowChunks.embedding} <=> ${vecLiteral})`;

  const rows = await db
    .select({
      id: schema.knowhowChunks.id,
      productId: schema.knowhowChunks.productId,
      text: schema.knowhowChunks.text,
      distance,
    })
    .from(schema.knowhowChunks)
    .where(
      and(
        eq(schema.knowhowChunks.tenantId, tenantId),
        productId ? eq(schema.knowhowChunks.productId, productId) : sql`true`,
        sql`${schema.knowhowChunks.embedding} is not null`,
      ),
    )
    .orderBy(distance)
    .limit(k);

  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    text: r.text,
    score: Number((1 - Number(r.distance)).toFixed(4)),
    strategy: "vector" as const,
  }));
}

async function trigramSearch(
  tenantId: string,
  productId: string | null,
  query: string,
  k: number,
): Promise<KnowhowChunk[]> {
  const similarity = sql<number>`similarity(${schema.knowhowChunks.text}, ${query})`;

  const rows = await db
    .select({
      id: schema.knowhowChunks.id,
      productId: schema.knowhowChunks.productId,
      text: schema.knowhowChunks.text,
      score: similarity,
    })
    .from(schema.knowhowChunks)
    .where(
      and(
        eq(schema.knowhowChunks.tenantId, tenantId),
        productId ? eq(schema.knowhowChunks.productId, productId) : sql`true`,
      ),
    )
    .orderBy(desc(similarity))
    .limit(k);

  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    text: r.text,
    score: Number(Number(r.score).toFixed(4)),
    strategy: "trigram" as const,
  }));
}
