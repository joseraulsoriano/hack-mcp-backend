import { db, schema } from "../db/client.ts";

export interface PublishEventInput {
  tenantId: string;
  type: string;
  payload?: Record<string, unknown>;
  leadId?: string | null;
}

/**
 * Bus de eventos minimalista en Postgres. Cuando escale lo cambiamos por
 * NATS o Redis Streams sin tocar el resto del codigo.
 */
export async function publishEvent(input: PublishEventInput) {
  const [row] = await db
    .insert(schema.events)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload ?? {},
      leadId: input.leadId ?? null,
    })
    .returning();
  return row ?? null;
}
