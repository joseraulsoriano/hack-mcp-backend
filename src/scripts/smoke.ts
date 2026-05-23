import { sqlClient } from "../db/client.ts";
import { toolDefinitions } from "../mcp/tools.ts";
import { emptyPapeleta } from "../db/schema.ts";

/**
 * Smoke end-to-end: ejercita las tools del MCP como las usaria un cliente externo.
 * Si esto pasa, M3+M6 estan funcionales.
 */

function tool(name: string) {
  const t = toolDefinitions.find((d) => d.name === name);
  if (!t) throw new Error(`tool '${name}' no encontrada`);
  return t;
}

async function call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const t = tool(name);
  const parsed = t.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`args invalidos para ${name}: ${JSON.stringify(parsed.error.flatten())}`);
  }
  return (await t.handler(parsed.data)) as T;
}

function header(title: string) {
  console.log("\n=== " + title);
}

async function main() {
  const tenant_slug = process.env.DEFAULT_TENANT_SLUG ?? "acme";

  header("list_products");
  const productsRes = (await call("list_products", { tenant_slug })) as {
    products: Array<{ id: string; slug: string; name: string }>;
  };
  console.log(productsRes.products.map((p) => `  ${p.slug}  ${p.name}`).join("\n"));

  header("create_lead (con transcript inicial)");
  const phone = `+52155500${Math.floor(Math.random() * 9000 + 1000)}`;
  const createRes = (await call("create_lead", {
    tenant_slug,
    name: "Agustin Mendoza",
    phone,
    source: "smoke",
    product_slug: "saas-billing",
    transcript:
      "Agustin: estamos batallando con la facturacion en SAT, tardamos 2 dias por cliente. Necesitamos algo que se conecte directo. Yo decido la compra, somos como 8 personas y queremos arrancar este mes.",
  })) as { lead: { id: string; phone: string | null; name: string | null } };
  console.log("  lead:", createRes.lead.id, createRes.lead.name, createRes.lead.phone);

  header("update_papeleta (simulando lo que hara M2)");
  const filled = emptyPapeleta();
  filled.musts.need = {
    answered: true,
    evidence: "tardamos 2 dias por cliente facturando",
    value: "automatizar facturacion CFDI",
  };
  filled.musts.product_match = {
    answered: true,
    evidence: "necesita conexion directa al SAT",
    value: "saas-billing",
  };
  filled.musts.timing = {
    answered: true,
    evidence: "queremos arrancar este mes",
    value: "<30 dias",
  };
  filled.musts.authority = {
    answered: true,
    evidence: "yo decido la compra",
    value: "decisor",
  };
  filled.musts.intent_signal = {
    answered: true,
    evidence: "queremos arrancar este mes",
    value: "alto",
  };
  filled.productHint = "saas-billing";
  filled.notes = "Equipo de 8 personas, prioridad alta.";
  filled.filledAt = new Date().toISOString();

  await call("update_papeleta", {
    tenant_slug,
    lead_id: createRes.lead.id,
    papeleta: filled,
    intent: "hot",
    status: "assigned",
    product_slug: "saas-billing",
    assigned_phone: "+528001234567",
  });
  console.log("  papeleta actualizada, status=assigned, intent=hot");

  header("get_lead_context (por telefono)");
  const ctx = (await call("get_lead_context", {
    tenant_slug,
    lead_key: createRes.lead.phone ?? createRes.lead.id,
  })) as {
    found: boolean;
    lead?: { name: string | null; intent: string; status: string };
    product?: { name: string } | null;
    recentTranscripts?: Array<{ text: string }>;
  };
  if (ctx.found) {
    console.log("  lead:", ctx.lead?.name, "->", ctx.lead?.intent, ctx.lead?.status);
    console.log("  producto:", ctx.product?.name);
    console.log("  transcripts:", ctx.recentTranscripts?.length);
  }

  header("query_knowhow (full tenant)");
  const r1 = (await call("query_knowhow", {
    tenant_slug,
    query: "cuanto cuesta el plan starter?",
    k: 3,
  })) as { chunks: Array<{ text: string; score: number; strategy: string }> };
  for (const c of r1.chunks) console.log(`  [${c.strategy} ${c.score}] ${c.text}`);

  header("query_knowhow (filtrado a consultoria)");
  const r2 = (await call("query_knowhow", {
    tenant_slug,
    product_slug: "sales-consulting",
    query: "metodologia de calificacion B2B",
    k: 3,
  })) as { chunks: Array<{ text: string; score: number; strategy: string }> };
  for (const c of r2.chunks) console.log(`  [${c.strategy} ${c.score}] ${c.text}`);

  header("list_leads (intent hot)");
  const leadsRes = (await call("list_leads", {
    tenant_slug,
    limit: 10,
  })) as { leads: Array<{ name: string | null; intent: string; status: string }> };
  for (const l of leadsRes.leads) console.log(`  ${l.name}  intent=${l.intent}  status=${l.status}`);

  console.log("\nSMOKE OK");
  await sqlClient.end();
}

main().catch(async (err) => {
  console.error("SMOKE FAIL", err);
  await sqlClient.end();
  process.exit(1);
});
