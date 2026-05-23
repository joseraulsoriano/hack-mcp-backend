import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import type { LeadPapeleta } from "../db/schema.ts";

export type LeadStatus = (typeof schema.leadStatus.enumValues)[number];
export type LeadIntent = (typeof schema.leadIntent.enumValues)[number];

export interface CreateLeadInput {
  tenantId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string;
  papeleta?: LeadPapeleta;
  assignedProductId?: string | null;
  assignedPhone?: string | null;
}

export async function createLead(input: CreateLeadInput) {
  const [row] = await db
    .insert(schema.leads)
    .values({
      tenantId: input.tenantId,
      name: input.name ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      source: input.source ?? "manual",
      papeleta: input.papeleta,
      assignedProductId: input.assignedProductId ?? null,
      assignedPhone: input.assignedPhone ?? null,
    })
    .returning();
  if (!row) throw new Error("createLead: no row");
  return row;
}

export interface ListLeadsFilters {
  tenantId: string;
  status?: LeadStatus;
  productId?: string;
  limit?: number;
}

export async function listLeads(filters: ListLeadsFilters) {
  const { tenantId, status, productId, limit = 50 } = filters;
  return db
    .select()
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        status ? eq(schema.leads.status, status) : sql`true`,
        productId ? eq(schema.leads.assignedProductId, productId) : sql`true`,
      ),
    )
    .orderBy(desc(schema.leads.updatedAt))
    .limit(limit);
}

export async function getLeadById(tenantId: string, leadId: string) {
  const [row] = await db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.id, leadId)))
    .limit(1);
  return row ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findLeadByPhoneOrId(tenantId: string, key: string) {
  const isUuid = UUID_RE.test(key);
  const [row] = await db
    .select()
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        isUuid ? eq(schema.leads.id, key) : eq(schema.leads.phone, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface UpdatePapeletaInput {
  tenantId: string;
  leadId: string;
  papeleta: LeadPapeleta;
  intent?: LeadIntent;
  status?: LeadStatus;
  assignedProductId?: string | null;
  assignedPhone?: string | null;
}

export async function updateLeadProfile(input: UpdatePapeletaInput) {
  const [row] = await db
    .update(schema.leads)
    .set({
      papeleta: input.papeleta,
      intent: input.intent ?? undefined,
      status: input.status ?? undefined,
      assignedProductId:
        input.assignedProductId === undefined ? undefined : input.assignedProductId,
      assignedPhone: input.assignedPhone === undefined ? undefined : input.assignedPhone,
      updatedAt: new Date(),
    })
    .where(
      and(eq(schema.leads.tenantId, input.tenantId), eq(schema.leads.id, input.leadId)),
    )
    .returning();
  if (!row) throw new Error("updateLeadProfile: lead no encontrado");
  return row;
}

export async function getLeadContext(tenantId: string, leadKey: string) {
  const lead = await findLeadByPhoneOrId(tenantId, leadKey);
  if (!lead) return null;

  const [product] = lead.assignedProductId
    ? await db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, lead.assignedProductId))
        .limit(1)
    : [];

  const recentTranscripts = await db
    .select({
      id: schema.transcripts.id,
      text: schema.transcripts.text,
      source: schema.transcripts.source,
      createdAt: schema.transcripts.createdAt,
    })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.leadId, lead.id))
    .orderBy(desc(schema.transcripts.createdAt))
    .limit(3);

  const recentConversations = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.leadId, lead.id))
    .orderBy(desc(schema.conversations.startedAt))
    .limit(3);

  return {
    lead,
    product: product ?? null,
    recentTranscripts,
    recentConversations,
  };
}
