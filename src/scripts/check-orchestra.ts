/**
 * Smoke end-to-end de la orquesta M1 + M2/M4 + M3/M6.
 *
 * Simula a M1 (el frontend de las Glasses) mandando un transcript real al
 * MCP, luego dispara el webhook de M2 (Perfilador), comprueba que la papeleta
 * quedo persistida en el MCP, y finalmente conversa con M4 (Experto) para
 * validar que el RAG y el contexto del lead se enganchan.
 *
 * Si esto pasa, los 4 modulos hablan entre si por la red sin trampas.
 *
 * Variables:
 *   MCP_BASE_URL  default http://localhost:3333
 *   M2_BASE_URL   default http://localhost:8000
 */

const MCP = (process.env.MCP_BASE_URL ?? "http://localhost:3333").replace(/\/$/, "");
const M2 = (process.env.M2_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
const TENANT = process.env.DEFAULT_TENANT_SLUG ?? "acme";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name} -> ${detail}`);
}

function section(title: string) {
  console.log(`\n=== ${title}`);
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t) as T;
}

async function main() {
  console.log(`[orchestra] MCP = ${MCP}`);
  console.log(`[orchestra] M2  = ${M2}`);

  // 0. Health checks ---------------------------------------------------------
  section("0. Health");
  try {
    const h = await getJson<{ ok: boolean }>(`${MCP}/health`);
    record("MCP /health", h.ok === true, JSON.stringify(h));
  } catch (e) {
    record("MCP /health", false, (e as Error).message);
    return finish();
  }

  let llmEnabled = false;
  try {
    const h = await getJson<{ ok: boolean; llm_enabled: boolean; mcp_url: string }>(
      `${M2}/health`,
    );
    llmEnabled = h.llm_enabled === true;
    record("M2 /health", h.ok === true, `llm_enabled=${llmEnabled} mcp_url=${h.mcp_url}`);
  } catch (e) {
    record("M2 /health", false, (e as Error).message);
    return finish();
  }

  // 1. M1 -> MCP: ingesta del transcript ------------------------------------
  // M1 NO sabe que M2 existe. Solo manda al MCP. El MCP es quien hace fan-out
  // server-side a M2 (env M2_WEBHOOK_URL). Si todo esta bien, M2 perfila solo.
  section("1. M1 (Glasses) ingiere transcript en el MCP (sin tocar M2 directo)");
  const phone = `+5215588${Math.floor(Math.random() * 900_000 + 100_000)}`;
  const transcriptText =
    "Hablante 1: Hola, te muestro las opciones de facturacion electronica.\n" +
    "Cliente: Hola, soy Agustin. Estamos batallando con la facturacion en SAT, " +
    "perdemos 2 dias por cliente. Yo decido la compra, somos 8 personas y " +
    "necesitamos arrancar este mes.";

  let leadId: string | null = null;
  try {
    const ingest = await postJson<{
      ok: boolean;
      created_lead: boolean;
      lead_id: string;
      transcript_id: string;
    }>(`${MCP}/tools/ingest_transcript`, {
      tenant_slug: TENANT,
      source: "glasses",
      name: "Agustin",
      phone,
      transcript: transcriptText,
      transcript_meta: {
        language: "es",
        duration_ms: 18000,
        recorded_at: new Date().toISOString(),
        speakers: [
          { id: "speaker_1", label: "Vendedor", nearField: true },
          { id: "speaker_2", label: "Agustin", nearField: false },
        ],
        segments: [
          {
            speakerId: "speaker_1",
            role: "seller",
            text: "Hola, te muestro las opciones de facturacion electronica.",
            tsStart: 0,
            tsEnd: 5,
          },
          {
            speakerId: "speaker_2",
            role: "lead",
            text: "Hola, soy Agustin. Estamos batallando con la facturacion en SAT...",
            tsStart: 5,
            tsEnd: 18,
          },
        ],
      },
    });
    leadId = ingest.lead_id;
    record(
      "ingest_transcript (lo unico que dispara M1)",
      ingest.ok && !!leadId,
      `lead_id=${leadId?.slice(0, 8)}... transcript_id=${ingest.transcript_id.slice(0, 8)}...`,
    );
  } catch (e) {
    record("ingest_transcript", false, (e as Error).message);
    return finish();
  }

  // 2. Polling: el MCP debio haber notificado a M2 -> M2 actualiza papeleta -
  section("2. M2 reacciona AUTOMATICAMENTE al fan-out del MCP (poll <=15s)");
  type Ctx = {
    found: boolean;
    lead?: {
      id: string;
      intent: string;
      status: string;
      papeleta: { musts: Record<string, { answered: boolean }> };
    };
    product?: { slug: string; name: string } | null;
    recentTranscripts?: Array<unknown>;
  };

  let finalCtx: Ctx | null = null;
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const ctx = await postJson<Ctx>(`${MCP}/tools/get_lead_context`, {
        tenant_slug: TENANT,
        lead_key: leadId,
      });
      if (ctx.found && ctx.lead && ctx.lead.status !== "new") {
        finalCtx = ctx;
        break;
      }
    } catch {
      // keep polling
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!finalCtx) {
    record(
      "M2 reacciono al fan-out",
      false,
      `papeleta sigue vacia tras ${elapsed}s. M2 caido? M2_WEBHOOK_URL no seteado en el MCP?`,
    );
    return finish();
  }
  const answered = Object.values(finalCtx.lead!.papeleta.musts ?? {}).filter(
    (v) => v.answered,
  ).length;
  record(
    "M2 reacciono al fan-out",
    true,
    `tras ${elapsed}s -> status=${finalCtx.lead!.status} intent=${finalCtx.lead!.intent} producto=${finalCtx.product?.slug ?? "null"} musts=${answered}/5`,
  );

  // 4. M4 chat: usa contexto + RAG ------------------------------------------
  section("4. M4 (Experto) responde usando contexto del lead + RAG");
  try {
    const chat = await postJson<{
      answer: string;
      used_context: Array<{ text: string; score?: number; strategy?: string }>;
      lead_id: string;
      product_slug: string | null;
    }>(`${M2}/expert/chat`, {
      lead_id: leadId,
      user_message: "Cuanto cuesta el plan starter del producto?",
    });
    const ok = chat.answer.length > 0 && chat.used_context.length > 0;
    record(
      "POST /expert/chat",
      ok,
      `producto=${chat.product_slug} chunks=${chat.used_context.length} respuesta="${chat.answer.slice(0, 70)}..."`,
    );
    if (chat.used_context[0]) {
      console.log(`         top_chunk: "${chat.used_context[0].text.slice(0, 90)}..."`);
    }
  } catch (e) {
    record("/expert/chat", false, (e as Error).message);
    return finish();
  }

  finish();
}

function finish() {
  console.log("\n--- resumen ---");
  const failed = steps.filter((s) => !s.ok);
  for (const s of steps) console.log(`  ${s.ok ? "OK  " : "FAIL"} ${s.name}`);
  if (failed.length === 0) {
    console.log("\nORCHESTRA OK  ->  M1 -> MCP -> M2 -> MCP -> M4 funciona end-to-end");
    process.exit(0);
  } else {
    console.log(`\nORCHESTRA FAIL  ->  ${failed.length} chequeo(s) fallaron`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[orchestra] error fatal:", err);
  process.exit(1);
});
