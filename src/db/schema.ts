import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  index,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Tenancy raiz. Todo lo demas cuelga de aqui via tenant_id.
 * Para el hack metemos uno solo (`acme`) en el seed.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userRole = pgEnum("user_role", ["seller", "manager", "admin"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: userRole("role").notNull().default("seller"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailPerTenant: uniqueIndex("users_email_per_tenant_uq").on(t.tenantId, t.email),
  }),
);

/**
 * Catalogo de productos por tenant. El Agente Experto se especializa por producto.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().default({}).notNull(),
    expertPrompt: text("expert_prompt"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerTenant: uniqueIndex("products_slug_per_tenant_uq").on(t.tenantId, t.slug),
  }),
);

export const leadStatus = pgEnum("lead_status", [
  "new",
  "profiling",
  "assigned",
  "engaged",
  "meeting_booked",
  "won",
  "lost",
  "discarded",
]);

export const leadIntent = pgEnum("lead_intent", ["hot", "warm", "cold", "unknown"]);

/**
 * Lead = persona perfilada. La papeleta vive como JSONB para no migrar cada vez que
 * el equipo de producto cambie los musts.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name"),
    phone: varchar("phone", { length: 32 }),
    email: text("email"),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    status: leadStatus("status").notNull().default("new"),
    intent: leadIntent("intent").notNull().default("unknown"),
    papeleta: jsonb("papeleta").$type<LeadPapeleta>().default(emptyPapeleta()).notNull(),
    assignedProductId: uuid("assigned_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    assignedPhone: varchar("assigned_phone", { length: 32 }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    phonePerTenant: uniqueIndex("leads_phone_per_tenant_uq").on(t.tenantId, t.phone),
    byStatus: index("leads_status_idx").on(t.tenantId, t.status),
    byProduct: index("leads_product_idx").on(t.assignedProductId),
  }),
);

/**
 * Transcripts: lo que entrega el Modulo 1 (Ingesta). Lo dejamos listo aunque hoy
 * no escribamos M1, para que el MCP pueda ingerir transcripts crudos manualmente.
 */
export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    text: text("text").notNull(),
    audioUrl: text("audio_url"),
    segments: jsonb("segments").$type<TranscriptSegment[] | null>().default(null),
    meta: jsonb("meta").$type<TranscriptMeta>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byLead: index("transcripts_lead_idx").on(t.leadId),
  }),
);

export const conversationChannel = pgEnum("conversation_channel", [
  "voice",
  "whatsapp",
  "sms",
  "email",
  "manual",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: conversationChannel("channel").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    byLead: index("conversations_lead_idx").on(t.leadId),
  }),
);

export const messageRole = pgEnum("message_role", ["lead", "agent", "human", "system"]);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byConv: index("messages_conv_idx").on(t.conversationId, t.ts),
  }),
);

/**
 * Fuentes del knowhow (archivos, urls, MCPs externos). Versionado a nivel de fuente.
 */
export const knowhowSources = pgTable(
  "knowhow_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    kind: varchar("kind", { length: 32 }).notNull().default("file"),
    version: varchar("version", { length: 32 }).notNull().default("v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTenant: index("knowhow_sources_tenant_idx").on(t.tenantId),
  }),
);

/**
 * Chunks indexados con embeddings opcionales.
 * Si OPENAI_API_KEY no esta presente, embedding queda null y caemos a busqueda
 * por trigram (pg_trgm).
 */
export const EMBED_DIM = 1536;

export const knowhowChunks = pgTable(
  "knowhow_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => knowhowSources.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    tokens: integer("tokens"),
    embedding: vector("embedding", { dimensions: EMBED_DIM }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTenantProduct: index("knowhow_chunks_tenant_product_idx").on(t.tenantId, t.productId),
    trgmIdx: index("knowhow_chunks_trgm_idx").using(
      "gin",
      sql`${t.text} gin_trgm_ops`,
    ),
    embedIdx: index("knowhow_chunks_embedding_idx").using(
      "hnsw",
      sql`${t.embedding} vector_cosine_ops`,
    ),
  }),
);

/**
 * Log de eventos para auditoria + para que otros modulos publiquen sin acoplarse.
 * Podemos cambiarlo por NATS/Redis Streams mas adelante; el shape se mantiene.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTenantType: index("events_tenant_type_idx").on(t.tenantId, t.type, t.ts),
    byLead: index("events_lead_idx").on(t.leadId, t.ts),
  }),
);

// ---------------------------------------------------------------------------
// Tipos compartidos para la papeleta. JSONB nos deja iterar sin migrar.
// ---------------------------------------------------------------------------

export type MustKey = "need" | "product_match" | "timing" | "authority" | "intent_signal";

export interface MustAnswer {
  answered: boolean;
  evidence: string | null;
  value: string | null;
}

export interface LeadPapeleta {
  musts: Record<MustKey, MustAnswer>;
  productHint: string | null;
  notes: string | null;
  filledAt: string | null;
}

export function emptyPapeleta(): LeadPapeleta {
  const empty: MustAnswer = { answered: false, evidence: null, value: null };
  return {
    musts: {
      need: { ...empty },
      product_match: { ...empty },
      timing: { ...empty },
      authority: { ...empty },
      intent_signal: { ...empty },
    },
    productHint: null,
    notes: null,
    filledAt: null,
  };
}

export interface TranscriptSegment {
  speakerId: string;
  role?: "seller" | "lead" | "unknown";
  text: string;
  tsStart: number;
  tsEnd: number;
}

export interface TranscriptSpeaker {
  id: string;
  label: string;
  nearField: boolean;
}

/**
 * Metadata del transcript que NO necesita columnas dedicadas (idioma, duracion,
 * timestamp de grabacion, mapeo de speakers). Vive en JSONB para poder iterar
 * sin migrar el schema. Ahora mismo lo llena M1 con su output de Whisper.
 */
export interface TranscriptMeta {
  language?: string;
  durationMs?: number;
  recordedAt?: string;
  speakers?: TranscriptSpeaker[];
}
