import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { embedMany } from "./embed.ts";

export interface IngestChunkInput {
  tenantId: string;
  productId: string | null;
  sourceUri: string;
  chunks: string[];
  version?: string;
}

export interface IngestResult {
  sourceId: string;
  chunkCount: number;
  embedded: boolean;
}

/**
 * Inserta una fuente y sus chunks. Embeddings opcionales: si no hay OPENAI_API_KEY,
 * los chunks se guardan con embedding=null y `query_knowhow` cae a trigram.
 *
 * Reemplaza la fuente si ya existe (`replaceExisting`), util para reseed idempotente.
 */
export async function ingestKnowhow(
  input: IngestChunkInput,
  opts: { replaceExisting?: boolean } = {},
): Promise<IngestResult> {
  const { tenantId, productId, sourceUri, chunks, version = "v1" } = input;

  // Compute embeddings before the transaction (external API call)
  const embeddings = await embedMany(chunks);

  const sourceId = await db.transaction(async (tx) => {
    if (opts.replaceExisting) {
      await tx
        .delete(schema.knowhowSources)
        .where(
          and(
            eq(schema.knowhowSources.tenantId, tenantId),
            eq(schema.knowhowSources.uri, sourceUri),
          ),
        );
    }

    const [source] = await tx
      .insert(schema.knowhowSources)
      .values({ tenantId, productId: productId ?? null, uri: sourceUri, kind: "file", version })
      .returning({ id: schema.knowhowSources.id });

    if (!source) throw new Error("ingestKnowhow: no se pudo crear source");

    if (chunks.length > 0) {
      await tx.insert(schema.knowhowChunks).values(
        chunks.map((text, i) => ({
          tenantId,
          productId: productId ?? null,
          sourceId: source.id,
          text,
          embedding: embeddings[i] ?? null,
        })),
      );
    }

    return source.id;
  });

  return {
    sourceId,
    chunkCount: chunks.length,
    embedded: embeddings.some((e) => e !== null),
  };
}
