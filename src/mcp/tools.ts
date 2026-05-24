import { z } from "zod";
import { requireTenantBySlug } from "../repos/tenants.repo.ts";
import {
  createLead,
  getLeadById,
  getLeadContext,
  listLeads,
  updateLeadProfile,
} from "../repos/leads.repo.ts";
import { getProductBySlug, listProducts } from "../repos/products.repo.ts";
import { createTranscript } from "../repos/transcripts.repo.ts";
import { publishEvent } from "../repos/events.repo.ts";
import { queryKnowhow } from "../knowhow/query.ts";
import {
  emptyPapeleta,
  type LeadPapeleta,
  type TranscriptMeta,
  type TranscriptSegment,
} from "../db/schema.ts";

/**
 * Catalogo de tools del servidor MCP de M6.
 * Cada tool:
 *  - tiene schema de input via Zod (validado por el adaptador stdio/http)
 *  - resuelve el tenant por slug ANTES de cualquier escritura
 *  - publica un evento cuando hay cambio de estado del lead
 *
 * Esto es lo que cualquier cliente externo (Cursor, n8n, Salesforce, tu front)
 * consume para integrarse al CRM headless.
 */

const TenantInput = z.object({
  tenant_slug: z.string().min(1).describe("Slug del tenant. Para el hack: 'acme'."),
});

export const toolDefinitions = [
  {
    name: "list_products",
    description: "Lista los productos del catalogo del tenant.",
    schema: TenantInput,
    handler: async (args: z.infer<typeof TenantInput>) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);
      const products = await listProducts(tenant.id);
      return { tenant: { id: tenant.id, slug: tenant.slug }, products };
    },
  },
  {
    name: "list_leads",
    description:
      "Lista leads del tenant, opcionalmente filtrando por estado o por slug de producto asignado.",
    schema: TenantInput.extend({
      status: z
        .enum([
          "new",
          "profiling",
          "assigned",
          "engaged",
          "meeting_booked",
          "won",
          "lost",
          "discarded",
        ])
        .optional(),
      product_slug: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);
      let productId: string | undefined;
      if (args.product_slug) {
        const p = await getProductBySlug(tenant.id, args.product_slug);
        if (!p) throw new Error(`producto '${args.product_slug}' no existe`);
        productId = p.id;
      }
      const rows = await listLeads({
        tenantId: tenant.id,
        status: args.status,
        productId,
        limit: args.limit,
      });
      return { leads: rows };
    },
  },
  {
    name: "get_lead_context",
    description:
      "Devuelve el contexto completo del lead (datos, papeleta, producto asignado, ultimos transcripts y conversaciones). Acepta lead_id (uuid) o telefono.",
    schema: TenantInput.extend({
      lead_key: z.string().min(1).describe("UUID del lead o telefono."),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);
      const ctx = await getLeadContext(tenant.id, args.lead_key);
      if (!ctx) return { found: false };
      return { found: true, ...ctx };
    },
  },
  {
    name: "create_lead",
    description:
      "Crea un lead nuevo. Acepta opcionalmente un transcript inicial (texto de la reunion) que se guarda asociado. Devuelve el lead creado.",
    schema: TenantInput.extend({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      source: z.string().optional(),
      transcript: z.string().optional(),
      product_slug: z.string().optional(),
      papeleta: z.unknown().optional(),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);

      let productId: string | null = null;
      if (args.product_slug) {
        const p = await getProductBySlug(tenant.id, args.product_slug);
        if (!p) throw new Error(`producto '${args.product_slug}' no existe`);
        productId = p.id;
      }

      const papeleta = (args.papeleta as LeadPapeleta | undefined) ?? emptyPapeleta();

      const lead = await createLead({
        tenantId: tenant.id,
        name: args.name ?? null,
        phone: args.phone ?? null,
        email: args.email ?? null,
        source: args.source ?? "mcp",
        papeleta,
        assignedProductId: productId,
      });

      if (args.transcript) {
        await createTranscript({
          tenantId: tenant.id,
          leadId: lead.id,
          source: args.source ?? "mcp",
          text: args.transcript,
        });
      }

      await publishEvent({
        tenantId: tenant.id,
        type: "lead.created",
        leadId: lead.id,
        payload: { source: lead.source },
      });

      return { lead };
    },
  },
  {
    name: "update_papeleta",
    description:
      "Actualiza la papeleta del lead. Lo usa el Modulo 2 (Perfilador) despues de procesar un transcript. Cambia status/intent/producto asignado opcionalmente. Tambien acepta name/phone/email para que M2 pueda guardar la identidad del lead extraida del transcript: M5 (voice) necesita el phone para resolver leads por caller_id.",
    schema: TenantInput.extend({
      lead_id: z.string().uuid(),
      papeleta: z
        .object({
          musts: z.record(
            z.object({
              answered: z.boolean(),
              evidence: z.string().nullable(),
              value: z.string().nullable(),
            }),
          ),
          productHint: z.string().nullable(),
          notes: z.string().nullable(),
          filledAt: z.string().nullable(),
        })
        .passthrough(),
      intent: z.enum(["hot", "warm", "cold", "unknown"]).optional(),
      status: z
        .enum([
          "new",
          "profiling",
          "assigned",
          "engaged",
          "meeting_booked",
          "won",
          "lost",
          "discarded",
        ])
        .optional(),
      product_slug: z.string().optional(),
      assigned_phone: z.string().optional(),
      // Datos de identidad que M2 puede extraer del transcript. Cualquiera
      // de los 3 es opcional: solo se actualiza si viene en el payload.
      // M5 (voice) los necesita para resolver leads por caller_id.
      name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().email().nullable().optional(),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);

      let productId: string | null | undefined;
      if (args.product_slug) {
        const p = await getProductBySlug(tenant.id, args.product_slug);
        if (!p) throw new Error(`producto '${args.product_slug}' no existe`);
        productId = p.id;
      }

      const updated = await updateLeadProfile({
        tenantId: tenant.id,
        leadId: args.lead_id,
        papeleta: args.papeleta as LeadPapeleta,
        intent: args.intent,
        status: args.status,
        assignedProductId: productId,
        assignedPhone: args.assigned_phone,
        name: args.name,
        phone: args.phone,
        email: args.email,
      });

      await publishEvent({
        tenantId: tenant.id,
        type: "lead.papeleta_updated",
        leadId: updated.id,
        payload: { intent: updated.intent, status: updated.status },
      });

      return { lead: updated };
    },
  },
  {
    name: "ingest_transcript",
    description:
      "Ingiere un transcript desde M1 con el shape canonico de Meta Glasses/Whisper (transcript + transcript_meta con segments, speakers, language, duration_ms, recorded_at). Si lead_id se provee, adjunta el transcript al lead existente; si no, crea un lead vacio y devuelve su id. Idempotente: el mismo M1 puede llamarlo N veces.",
    schema: TenantInput.extend({
      source: z.enum(["glasses", "upload", "granola", "manual"]).default("glasses"),
      transcript: z.string().min(1).describe("Texto plano del transcript ya formateado por hablante."),
      transcript_meta: z
        .object({
          language: z.string().optional(),
          duration_ms: z.number().nonnegative().optional(),
          recorded_at: z.string().optional(),
          speakers: z
            .array(
              z.object({
                id: z.string(),
                label: z.string(),
                nearField: z.boolean(),
              }),
            )
            .optional(),
          segments: z
            .array(
              z.object({
                speakerId: z.string(),
                role: z.enum(["seller", "lead", "unknown"]).optional(),
                text: z.string(),
                tsStart: z.number(),
                tsEnd: z.number(),
              }),
            )
            .optional(),
        })
        .optional(),
      lead_id: z
        .string()
        .uuid()
        .optional()
        .describe("Si se provee, adjunta el transcript a este lead. Si no, crea uno nuevo."),
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      audio_url: z.string().url().optional(),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);

      let leadId = args.lead_id ?? null;
      let created = false;

      if (leadId) {
        const existing = await getLeadById(tenant.id, leadId);
        if (!existing) throw new Error(`lead '${leadId}' no existe`);
      } else {
        const lead = await createLead({
          tenantId: tenant.id,
          name: args.name ?? null,
          phone: args.phone ?? null,
          email: args.email ?? null,
          source: args.source,
        });
        leadId = lead.id;
        created = true;
        await publishEvent({
          tenantId: tenant.id,
          type: "lead.created",
          leadId,
          payload: { source: args.source, via: "ingest_transcript" },
        });
      }

      const segments = (args.transcript_meta?.segments ?? null) as
        | TranscriptSegment[]
        | null;
      const meta: TranscriptMeta = {
        language: args.transcript_meta?.language,
        durationMs: args.transcript_meta?.duration_ms,
        recordedAt: args.transcript_meta?.recorded_at,
        speakers: args.transcript_meta?.speakers,
      };

      const transcript = await createTranscript({
        tenantId: tenant.id,
        leadId,
        source: args.source,
        text: args.transcript,
        audioUrl: args.audio_url ?? null,
        segments,
        meta,
      });

      await publishEvent({
        tenantId: tenant.id,
        type: "transcript.ingested",
        leadId,
        payload: {
          transcript_id: transcript.id,
          source: args.source,
          duration_ms: args.transcript_meta?.duration_ms,
          segment_count: segments?.length ?? 0,
          speaker_count: args.transcript_meta?.speakers?.length ?? 0,
        },
      });

      // Fan-out a M2 (Perfilador) fire-and-forget. Si M2 esta caido o la env
      // no esta seteada, el ingest devuelve igual: M1 no se entera. El lock se
      // hace sobre lead_id para evitar bucles si M2 reingestara (no lo hace).
      void notifyProfiler({
        tenant_slug: args.tenant_slug,
        lead_id: leadId,
        transcript_id: transcript.id,
        transcript: args.transcript,
        source: args.source,
      });

      return {
        ok: true,
        created_lead: created,
        lead_id: leadId,
        transcript_id: transcript.id,
      };
    },
  },
  {
    name: "query_knowhow",
    description:
      "Busca chunks del knowhow del tenant. Si OPENAI_API_KEY esta presente usa similaridad vectorial con pgvector, sino cae a trigram. Filtrable por producto.",
    schema: TenantInput.extend({
      query: z.string().min(1),
      product_slug: z.string().optional(),
      k: z.number().int().min(1).max(20).optional(),
    }),
    handler: async (args) => {
      const tenant = await requireTenantBySlug(args.tenant_slug);
      let productId: string | null = null;
      if (args.product_slug) {
        const p = await getProductBySlug(tenant.id, args.product_slug);
        if (!p) throw new Error(`producto '${args.product_slug}' no existe`);
        productId = p.id;
      }
      const chunks = await queryKnowhow({
        tenantId: tenant.id,
        productId,
        query: args.query,
        k: args.k,
      });
      return { chunks };
    },
  },
] as const satisfies ReadonlyArray<ToolDef<z.ZodTypeAny>>;

// ---------------------------------------------------------------------------
// Tipos internos para que la lista sea iterable de forma uniforme.
// ---------------------------------------------------------------------------

export interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<unknown>;
}

export type AnyToolDef = ToolDef<z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Fan-out a M2 (Perfilador). El MCP es la fuente unica de verdad: cuando
// alguien (M1, n8n, Postman) ingesta un transcript, M2 se entera de forma
// automatica sin que el caller sepa nada.
//
// Si M2_WEBHOOK_URL no esta definida, no hace nada. Si esta y M2 esta caido,
// loguea y sigue: nunca rompe el ingest. Disena para idempotencia: si M2
// recibe el mismo transcript_id dos veces, debe acabar con la misma papeleta.
// ---------------------------------------------------------------------------

interface ProfilerNotice {
  tenant_slug: string;
  lead_id: string;
  transcript_id: string;
  transcript: string;
  source: string;
}

async function notifyProfiler(notice: ProfilerNotice): Promise<void> {
  const url = process.env.M2_WEBHOOK_URL;
  if (!url) return;
  try {
    // Timeout corto: M2 debe responder 202 ACCEPTED en <1s y procesar el LLM
    // en background. Si tarda mas, asumimos que cayo y seguimos sin bloquear.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_slug: notice.tenant_slug,
        lead_id: notice.lead_id,
        transcript_id: notice.transcript_id,
        transcript_text: notice.transcript,
        source: notice.source,
        session_id: notice.lead_id,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[mcp->m2] webhook ${url} respondio ${res.status}: ${body.slice(0, 200)}`,
      );
    } else {
      console.log(`[mcp->m2] webhook ok lead=${notice.lead_id.slice(0, 8)}`);
    }
  } catch (err) {
    console.warn(`[mcp->m2] webhook ${url} fallo: ${(err as Error).message}`);
  }
}
