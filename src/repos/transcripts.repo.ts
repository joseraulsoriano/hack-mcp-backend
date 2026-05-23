import { db, schema } from "../db/client.ts";

export interface CreateTranscriptInput {
  tenantId: string;
  leadId?: string | null;
  source?: string;
  text: string;
  audioUrl?: string | null;
}

export async function createTranscript(input: CreateTranscriptInput) {
  const [row] = await db
    .insert(schema.transcripts)
    .values({
      tenantId: input.tenantId,
      leadId: input.leadId ?? null,
      source: input.source ?? "manual",
      text: input.text,
      audioUrl: input.audioUrl ?? null,
    })
    .returning();
  if (!row) throw new Error("createTranscript: no row");
  return row;
}
