import { getLeadContext } from "../repos/leads.repo.ts";
import { requireTenantBySlug } from "../repos/tenants.repo.ts";
import type { LeadPapeleta } from "../db/schema.ts";

/**
 * ============================================================================
 *  voiceContext — adaptador para M5 (hackAIVoice / Twilio + ElevenLabs)
 * ============================================================================
 *
 *  El agente de voz tiene dos momentos criticos de carga de contexto:
 *
 *    1. /voice/identify  (sync, <100ms)
 *       Se llama dentro del POST /twilio/inbound. Si tarda mas, Twilio corta
 *       la llamada. Solo devuelve nombre y si es cliente activo para el
 *       saludo inicial: "Hola Agustin, dame un segundo...".
 *
 *    2. /voice/rag-profile  (async, <2s tolerable)
 *       Se llama 2.5s despues que conecta el WebSocket. Devuelve la
 *       informacion profunda que se inyecta como system_message al agente
 *       de ElevenLabs: ultima reunion, dolor, etapa, proxima accion.
 *
 *  Este modulo es el unico que conoce el SHAPE que espera M5. Si M5 cambia su
 *  contrato, este es el unico archivo a modificar.
 */

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_SLUG ?? "acme";

// ---------------------------------------------------------------------------
//  Tipos publicos (lo que M5 consume)
// ---------------------------------------------------------------------------

export interface VoiceIdentity {
  user_id: string | null;
  name: string;
  is_active_client: boolean;
  phone: string | null;
  lead_status: string;
}

export interface VoiceRagProfile {
  profile: {
    last_interaction: string | null;
    interested_products: string[];
    current_deal_stage: DealStage;
    summary_of_last_meeting: string;
    key_pain_points: string[];
  };
  sales_logic: {
    next_best_action: string;
    retention_policy: string;
  };
}

type DealStage =
  | "Discovery"
  | "Qualification"
  | "Negotiation"
  | "Closed Won"
  | "Closed Lost"
  | "Unknown";

// ---------------------------------------------------------------------------
//  identify — lookup rapido por telefono / lead_id
// ---------------------------------------------------------------------------

export async function buildIdentity(input: {
  tenant_slug?: string;
  phone?: string;
  lead_id?: string;
  from?: string; // alias Twilio
}): Promise<VoiceIdentity> {
  const key = input.lead_id ?? input.phone ?? input.from;
  if (!key) {
    return {
      user_id: null,
      name: "Cliente",
      is_active_client: false,
      phone: null,
      lead_status: "unknown",
    };
  }
  const tenant = await requireTenantBySlug(input.tenant_slug ?? DEFAULT_TENANT);
  const ctx = await getLeadContext(tenant.id, key);
  if (!ctx) {
    return {
      user_id: null,
      name: "Cliente",
      is_active_client: false,
      phone: typeof key === "string" && key.startsWith("+") ? key : null,
      lead_status: "unknown",
    };
  }
  return {
    user_id: ctx.lead.id,
    name: ctx.lead.name ?? "Cliente",
    is_active_client: ctx.lead.status !== "lost",
    phone: ctx.lead.phone ?? null,
    lead_status: ctx.lead.status,
  };
}

// ---------------------------------------------------------------------------
//  rag-profile — contexto profundo para inyectar al agente ElevenLabs
// ---------------------------------------------------------------------------

export async function buildRagProfile(input: {
  tenant_slug?: string;
  phone?: string;
  lead_id?: string;
  from?: string;
}): Promise<VoiceRagProfile | null> {
  const key = input.lead_id ?? input.phone ?? input.from;
  if (!key) return null;

  const tenant = await requireTenantBySlug(input.tenant_slug ?? DEFAULT_TENANT);
  const ctx = await getLeadContext(tenant.id, key);
  if (!ctx) return null;

  const lastTranscript = ctx.recentTranscripts[0] ?? null;
  const lastInteractionDate = lastTranscript?.createdAt ?? ctx.lead.updatedAt ?? null;

  return {
    profile: {
      last_interaction: lastInteractionDate
        ? new Date(lastInteractionDate).toISOString().slice(0, 10)
        : null,
      interested_products: derivedProducts(ctx.product?.name ?? null, ctx.lead.papeleta),
      current_deal_stage: mapDealStage(ctx.lead.status),
      summary_of_last_meeting: summarize(ctx.lead.papeleta, lastTranscript?.text ?? null),
      key_pain_points: extractPainPoints(ctx.lead.papeleta),
    },
    sales_logic: {
      next_best_action: nextBestAction(ctx.lead.status, ctx.lead.papeleta),
      retention_policy: retentionPolicy(ctx.product?.expertPrompt ?? null, ctx.product?.name ?? null),
    },
  };
}

// ---------------------------------------------------------------------------
//  Helpers — mapean nuestro modelo al lenguaje "sales" del agente
// ---------------------------------------------------------------------------

function mapDealStage(status: string): DealStage {
  switch (status) {
    case "new":
      return "Discovery";
    case "profiling":
      return "Qualification";
    case "active":
      return "Negotiation";
    case "won":
      return "Closed Won";
    case "lost":
      return "Closed Lost";
    default:
      return "Unknown";
  }
}

function derivedProducts(productName: string | null, papeleta: LeadPapeleta): string[] {
  const out: string[] = [];
  if (productName) out.push(productName);
  const match = papeleta.musts.product_match;
  if (match.answered && match.value && !out.includes(match.value)) {
    out.push(match.value);
  }
  return out;
}

function summarize(papeleta: LeadPapeleta, transcriptText: string | null): string {
  if (papeleta.notes && papeleta.notes.trim().length > 0) {
    return papeleta.notes.trim();
  }
  if (transcriptText) {
    const clean = transcriptText.replace(/\s+/g, " ").trim();
    return clean.length > 240 ? `${clean.slice(0, 240)}...` : clean;
  }
  return "Sin reuniones previas registradas.";
}

function extractPainPoints(papeleta: LeadPapeleta): string[] {
  const pts: string[] = [];
  const m = papeleta.musts;
  if (m.need.answered && m.need.value) pts.push(`Necesidad: ${m.need.value}`);
  if (m.timing.answered && m.timing.value) pts.push(`Urgencia: ${m.timing.value}`);
  if (m.authority.answered && m.authority.value) pts.push(`Decisor: ${m.authority.value}`);
  if (m.intent_signal.answered && m.intent_signal.value) {
    pts.push(`Senal de compra: ${m.intent_signal.value}`);
  }
  if (pts.length === 0) {
    pts.push("Sin dolor identificado aun, explorar en conversacion");
  }
  return pts;
}

function nextBestAction(status: string, papeleta: LeadPapeleta): string {
  if (status === "won") return "Confirmar el cierre y agendar onboarding.";
  if (status === "lost") return "Cerrar educadamente, dejar puerta abierta.";

  const m = papeleta.musts;
  const missing: string[] = [];
  if (!m.need.answered) missing.push("la necesidad concreta");
  if (!m.timing.answered) missing.push("los tiempos");
  if (!m.authority.answered) missing.push("quien decide la compra");
  if (!m.product_match.answered) missing.push("que producto le encaja");

  if (missing.length === 0) return "Avanzar a propuesta y cerrar.";
  if (missing.length === 1) return `Calificar: averiguar ${missing[0]}.`;
  return `Calificar primero: averiguar ${missing[0]} y ${missing[1]}.`;
}

function retentionPolicy(expertPrompt: string | null, productName: string | null): string {
  if (expertPrompt && expertPrompt.length > 0) {
    const first = expertPrompt.split(".")[0] ?? expertPrompt;
    return `Sigue tu prompt experto. ${first.slice(0, 180).trim()}.`;
  }
  if (productName) {
    return `Manten la conversacion centrada en ${productName}. Si menciona competencia, ofrecer demo personalizada antes de descuentos.`;
  }
  return "Escuchar primero, no ofrecer descuentos en la primera llamada.";
}
