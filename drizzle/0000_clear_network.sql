CREATE TYPE "public"."conversation_channel" AS ENUM('voice', 'whatsapp', 'sms', 'email', 'manual');--> statement-breakpoint
CREATE TYPE "public"."lead_intent" AS ENUM('hot', 'warm', 'cold', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'profiling', 'assigned', 'engaged', 'meeting_booked', 'won', 'lost', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('lead', 'agent', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('seller', 'manager', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lead_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowhow_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid,
	"source_id" uuid,
	"text" text NOT NULL,
	"tokens" integer,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowhow_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid,
	"uri" text NOT NULL,
	"kind" varchar(32) DEFAULT 'file' NOT NULL,
	"version" varchar(32) DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text,
	"phone" varchar(32),
	"email" text,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"intent" "lead_intent" DEFAULT 'unknown' NOT NULL,
	"papeleta" jsonb DEFAULT '{"musts":{"need":{"answered":false,"evidence":null,"value":null},"product_match":{"answered":false,"evidence":null,"value":null},"timing":{"answered":false,"evidence":null,"value":null},"authority":{"answered":false,"evidence":null,"value":null},"intent_signal":{"answered":false,"evidence":null,"value":null}},"productHint":null,"notes":null,"filledAt":null}'::jsonb NOT NULL,
	"assigned_product_id" uuid,
	"assigned_phone" varchar(32),
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"pricing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expert_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"text" text NOT NULL,
	"audio_url" text,
	"segments" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'seller' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowhow_chunks" ADD CONSTRAINT "knowhow_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowhow_chunks" ADD CONSTRAINT "knowhow_chunks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowhow_chunks" ADD CONSTRAINT "knowhow_chunks_source_id_knowhow_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowhow_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowhow_sources" ADD CONSTRAINT "knowhow_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowhow_sources" ADD CONSTRAINT "knowhow_sources_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_product_id_products_id_fk" FOREIGN KEY ("assigned_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_lead_idx" ON "conversations" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_tenant_type_idx" ON "events" USING btree ("tenant_id","type","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_lead_idx" ON "events" USING btree ("lead_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowhow_chunks_tenant_product_idx" ON "knowhow_chunks" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowhow_chunks_trgm_idx" ON "knowhow_chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowhow_chunks_embedding_idx" ON "knowhow_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowhow_sources_tenant_idx" ON "knowhow_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_phone_per_tenant_uq" ON "leads" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_status_idx" ON "leads" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_product_idx" ON "leads" USING btree ("assigned_product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conv_idx" ON "messages" USING btree ("conversation_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_per_tenant_uq" ON "products" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcripts_lead_idx" ON "transcripts" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_per_tenant_uq" ON "users" USING btree ("tenant_id","email");