import { z } from "zod";
import { requireTenantBySlug } from "../repos/tenants.repo.ts";
import {
  createLead,
  getLeadContext,
  listLeads,
  updateLeadProfile,
} from "../repos/leads.repo.ts";
import { getProductBySlug, listProducts } from "../repos/products.repo.ts";
import { createTranscript } from "../repos/transcripts.repo.ts";
import { publishEvent } from "../repos/events.repo.ts";
import { queryKnowhow } from "../knowhow/query.ts";
import { emptyPapeleta, type LeadPapeleta } from "../db/schema.ts";

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
      "Actualiza la papeleta del lead. Lo usa el Modulo 2 (Perfilador) despues de procesar un transcript. Cambia status/intent/producto asignado opcionalmente.",
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
