import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db, sqlClient, schema } from "./client.ts";
import { ingestKnowhow } from "../knowhow/ingest.ts";
import { embeddingsEnabled } from "../knowhow/embed.ts";

interface KnowhowFile {
  tenant: { slug: string; name: string };
  products: Array<{
    slug: string;
    name: string;
    summary: string;
    pricing: Record<string, unknown>;
    expertPrompt: string;
    knowhow: string[];
  }>;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const path = resolve(__dirname, "..", "knowhow", "knowhow.json");
  const raw = await readFile(path, "utf8");
  const file = JSON.parse(raw) as KnowhowFile;

  console.log("[seed] reset de tablas operativas");
  await db.execute(sql`
    truncate table
      ${schema.events},
      ${schema.messages},
      ${schema.conversations},
      ${schema.transcripts},
      ${schema.knowhowChunks},
      ${schema.knowhowSources},
      ${schema.leads},
      ${schema.products},
      ${schema.users},
      ${schema.tenants}
    restart identity cascade
  `);

  console.log(`[seed] tenant ${file.tenant.slug}`);
  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: file.tenant.slug, name: file.tenant.name })
    .returning();
  if (!tenant) throw new Error("seed: tenant no creado");

  await db.insert(schema.users).values([
    {
      tenantId: tenant.id,
      name: "Vendedor Demo",
      email: "vendedor@acme.test",
      role: "seller",
    },
    {
      tenantId: tenant.id,
      name: "Gerente Demo",
      email: "gerente@acme.test",
      role: "manager",
    },
  ]);

  console.log(`[seed] embeddings: ${embeddingsEnabled() ? "ON (OpenAI)" : "OFF (trigram fallback)"}`);

  for (const p of file.products) {
    console.log(`[seed] producto ${p.slug}`);
    const [product] = await db
      .insert(schema.products)
      .values({
        tenantId: tenant.id,
        slug: p.slug,
        name: p.name,
        summary: p.summary,
        pricing: p.pricing,
        expertPrompt: p.expertPrompt,
      })
      .returning();
    if (!product) throw new Error(`seed: producto ${p.slug} no creado`);

    const res = await ingestKnowhow(
      {
        tenantId: tenant.id,
        productId: product.id,
        sourceUri: `seed://${p.slug}`,
        chunks: p.knowhow,
      },
      { replaceExisting: true },
    );
    console.log(`  -> ${res.chunkCount} chunks ingeridos (embedded=${res.embedded})`);
  }

  console.log("[seed] listo");
  await sqlClient.end();
}

main().catch(async (err) => {
  console.error("[seed] error", err);
  await sqlClient.end();
  process.exit(1);
});
