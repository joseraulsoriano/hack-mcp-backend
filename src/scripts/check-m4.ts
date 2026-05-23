/**
 * Readiness check para el Modulo 4 (Agente Experto).
 *
 * M4 vive afuera de este repo (FastAPI + httpx en Python) y solo habla con el MCP
 * via HTTP. Este script simula EXACTAMENTE lo que M4 hara en runtime para validar
 * que las 3 tools que necesita estan vivas, contestan en el shape esperado y son
 * suficientes para responder un mensaje del lead.
 *
 * Flujo simulado (happy path del Agente Experto):
 *   1. M1 ingiere un transcript (ingest_transcript) -> crea lead nuevo.
 *   2. M2 procesa y publica la papeleta (update_papeleta) -> lead engaged + hot.
 *   3. M4 recupera contexto del lead          (get_lead_context).
 *   4. M4 hace RAG sobre el knowhow           (query_knowhow).
 *   5. M4 descubre algo nuevo y actualiza      (update_papeleta).
 *   6. M4 vuelve a leer el contexto y verifica que el cambio quedo persistido.
 *
 * Si este script termina con "M4 READY", el Agente Experto puede arrancar a
 * conectarse al MCP sin sorpresas de contrato.
 *
 * Uso:
 *   bun run m4:check                              # contra http://localhost:3333
 *   MCP_BASE_URL=http://192.168.11.100:3333 bun run m4:check
 */

const BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3333";
const TENANT_SLUG = process.env.DEFAULT_TENANT_SLUG ?? "acme";

const REQUIRED_TOOLS = [
  "get_lead_context",
  "query_knowhow",
  "update_papeleta",
  "ingest_transcript",
] as const;

type ToolInfo = { name: string; description: string };
type Step = { name: string; ok: boolean; detail: string };

const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  const tag = ok ? "OK  " : "FAIL";
  console.log(`  [${tag}] ${name} -> ${detail}`);
}

function section(title: string) {
  console.log(`\n=== ${title}`);
}

async function callTool<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE_URL}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /tools/${name} -> ${res.status} ${res.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`POST /tools/${name} respondio no-JSON: ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log(`[m4-check] target = ${BASE_URL}`);
  console.log(`[m4-check] tenant = ${TENANT_SLUG}\n`);

  // 0. Health + descubrimiento de tools ---------------------------------------
  section("0. MCP alive + tool discovery");

  try {
    const r = await fetch(`${BASE_URL}/health`);
    record("GET /health", r.ok, r.ok ? "200" : `${r.status}`);
  } catch (err) {
    record("GET /health", false, (err as Error).message);
    return finish();
  }

  let toolsList: ToolInfo[] = [];
  try {
    const r = await fetch(`${BASE_URL}/tools`);
    const j = (await r.json()) as { tools: ToolInfo[] };
    toolsList = j.tools ?? [];
    record("GET /tools", toolsList.length > 0, `${toolsList.length} tools expuestas`);
  } catch (err) {
    record("GET /tools", false, (err as Error).message);
    return finish();
  }

  for (const t of REQUIRED_TOOLS) {
    const present = toolsList.some((tt) => tt.name === t);
    record(`tool '${t}' presente`, present, present ? "registrada" : "AUSENTE");
  }

  // 1. Crear escenario: lead + transcript via ingest_transcript ---------------
  section("1. Setup (simulando M1 + M2 que corren en paralelo)");

  const phone = `+5215588${Math.floor(Math.random() * 900_000 + 100_000)}`;
  let leadId: string | null = null;

  try {
    const ingest = await callTool<{
      ok: boolean;
      created_lead: boolean;
      lead_id: string;
      transcript_id: string;
    }>("ingest_transcript", {
      tenant_slug: TENANT_SLUG,
      source: "glasses",
      name: "Lead M4 Check",
      phone,
      transcript:
        "Lead: estamos batallando con la facturacion electronica, perdemos 2 dias por cliente. " +
        "Yo decido la compra, somos 8 personas y necesitamos arrancar este mes.",
      transcript_meta: {
        language: "es-MX",
        duration_ms: 95_000,
        recorded_at: new Date().toISOString(),
        speakers: [
          { id: "s1", label: "vendedor", nearField: true },
          { id: "s2", label: "lead", nearField: false },
        ],
        segments: [
          {
            speakerId: "s2",
            role: "lead",
            text: "Estamos batallando con la facturacion electronica.",
            tsStart: 0,
            tsEnd: 5000,
          },
          {
            speakerId: "s1",
            role: "seller",
            text: "Cuentame mas, cuanto les toma hoy?",
            tsStart: 5000,
            tsEnd: 9000,
          },
        ],
      },
    });
    leadId = ingest.lead_id;
    record(
      "ingest_transcript (simula M1)",
      ingest.ok && ingest.created_lead && !!leadId,
      `lead_id=${leadId?.slice(0, 8)}... transcript_id=${ingest.transcript_id.slice(0, 8)}...`,
    );
  } catch (err) {
    record("ingest_transcript (simula M1)", false, (err as Error).message);
    return finish();
  }

  // M2 perfila el lead. Lo simulamos aqui para tener una papeleta lista.
  try {
    const papeleta = {
      musts: {
        need: {
          answered: true,
          evidence: "perdemos 2 dias por cliente facturando",
          value: "automatizar facturacion CFDI",
        },
        product_match: {
          answered: true,
          evidence: "menciono facturacion electronica",
          value: "saas-billing",
        },
        timing: {
          answered: true,
          evidence: "necesitamos arrancar este mes",
          value: "<30 dias",
        },
        authority: {
          answered: true,
          evidence: "yo decido la compra",
          value: "decisor",
        },
        intent_signal: {
          answered: true,
          evidence: "necesitamos arrancar este mes",
          value: "alto",
        },
      },
      productHint: "saas-billing",
      notes: "Equipo de 8 personas, prioridad alta.",
      filledAt: new Date().toISOString(),
    };

    await callTool("update_papeleta", {
      tenant_slug: TENANT_SLUG,
      lead_id: leadId,
      papeleta,
      intent: "hot",
      status: "engaged",
      product_slug: "saas-billing",
    });
    record("update_papeleta (simula M2)", true, "intent=hot status=engaged producto=saas-billing");
  } catch (err) {
    record("update_papeleta (simula M2)", false, (err as Error).message);
    return finish();
  }

  // 2. Lo que M4 hace al recibir un mensaje del lead -------------------------
  section("2. Camino feliz del Agente Experto (M4)");

  type Ctx = {
    found: boolean;
    lead?: {
      id: string;
      name: string | null;
      intent: string;
      status: string;
      papeleta: Record<string, unknown>;
    };
    product?: { slug: string; name: string; expertPrompt?: string | null } | null;
    recentTranscripts?: Array<{ id: string; text: string }>;
    conversations?: unknown[];
  };

  let ctx: Ctx;
  try {
    ctx = await callTool<Ctx>("get_lead_context", {
      tenant_slug: TENANT_SLUG,
      lead_key: leadId!,
    });
    const okShape =
      ctx.found === true &&
      !!ctx.lead?.id &&
      !!ctx.lead?.papeleta &&
      Array.isArray(ctx.recentTranscripts);
    record(
      "get_lead_context devuelve papeleta + transcripts",
      okShape,
      `found=${ctx.found} producto=${ctx.product?.slug ?? "null"} transcripts=${ctx.recentTranscripts?.length ?? 0}`,
    );
    if (!okShape) return finish();
  } catch (err) {
    record("get_lead_context", false, (err as Error).message);
    return finish();
  }

  // RAG. M4 lo usa para fundamentar la respuesta. Filtramos por el producto
  // que ya quedo asignado en el contexto, igual que hara M4.
  type Chunks = {
    chunks: Array<{ id: string; text: string; score: number; strategy: string }>;
  };
  try {
    const rag = await callTool<Chunks>("query_knowhow", {
      tenant_slug: TENANT_SLUG,
      product_slug: ctx.product?.slug ?? "saas-billing",
      query: "cuanto cuesta el plan starter y que incluye?",
      k: 3,
    });
    const ok = rag.chunks.length > 0;
    record(
      "query_knowhow filtrado por producto del lead",
      ok,
      ok
        ? `${rag.chunks.length} chunks (strategy=${rag.chunks[0].strategy}, top score=${rag.chunks[0].score.toFixed(3)})`
        : "0 chunks",
    );
    if (ok) {
      console.log(`         top: "${rag.chunks[0].text.slice(0, 90)}..."`);
    }
  } catch (err) {
    record("query_knowhow", false, (err as Error).message);
    return finish();
  }

  // M4 descubrio algo nuevo en la charla. Lo escribe en la papeleta.
  try {
    const currentPapeleta = ctx.lead!.papeleta as {
      musts: Record<string, { answered: boolean; evidence: string | null; value: string | null }>;
      productHint: string | null;
      notes: string | null;
      filledAt: string | null;
    };

    const nextNotes = `${currentPapeleta.notes ?? ""}\n[M4] pidio demo guiada el viernes`.trim();
    const nextPapeleta = {
      ...currentPapeleta,
      notes: nextNotes,
      filledAt: new Date().toISOString(),
    };

    await callTool("update_papeleta", {
      tenant_slug: TENANT_SLUG,
      lead_id: leadId,
      papeleta: nextPapeleta,
      intent: "hot",
      status: "meeting_booked",
    });
    record(
      "update_papeleta desde M4 (write-back)",
      true,
      "agrego nota + cambio status a meeting_booked",
    );
  } catch (err) {
    record("update_papeleta desde M4", false, (err as Error).message);
    return finish();
  }

  // 3. Verificacion: lo que escribimos se ve al releer el contexto -----------
  section("3. Persistencia: relectura confirma el write-back");

  try {
    const ctx2 = await callTool<Ctx>("get_lead_context", {
      tenant_slug: TENANT_SLUG,
      lead_key: leadId!,
    });
    const persisted =
      ctx2.lead?.status === "meeting_booked" &&
      JSON.stringify(ctx2.lead?.papeleta ?? {}).includes("[M4] pidio demo guiada");
    record(
      "cambios de M4 persisten",
      persisted,
      `status=${ctx2.lead?.status} notes_ok=${persisted}`,
    );
  } catch (err) {
    record("relectura get_lead_context", false, (err as Error).message);
  }

  finish();
}

function finish() {
  console.log("\n--- resumen ---");
  const failed = steps.filter((s) => !s.ok);
  for (const s of steps) {
    console.log(`  ${s.ok ? "OK  " : "FAIL"} ${s.name}`);
  }
  if (failed.length === 0) {
    console.log("\nM4 READY  ->  el Agente Experto puede consumir el MCP en " + BASE_URL);
    console.log("              tools listas: get_lead_context, query_knowhow, update_papeleta");
    process.exit(0);
  } else {
    console.log(`\nM4 NOT READY  ->  ${failed.length} chequeo(s) fallaron`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[m4-check] error fatal:", err);
  process.exit(1);
});
