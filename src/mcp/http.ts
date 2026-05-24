import { Hono } from "hono";
import { cors } from "hono/cors";
import { toolDefinitions } from "./tools.ts";
import { buildIdentity, buildRagProfile } from "./voiceContext.ts";

/**
 * Misma capa de tools que el MCP stdio, expuesta como HTTP JSON. Sirve para:
 *  - Probar rapido desde curl / Postman / Insomnia.
 *  - Conectar el front Next.js sin tener que hablar MCP nativo.
 *  - Cualquier servicio externo (n8n, Zapier, webhooks) que no sea MCP-aware.
 *
 * Cuando el equipo este listo, todo se sirve solo desde MCP. Esto es disposable.
 */

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.get("/tools", (c) =>
  c.json({
    tools: toolDefinitions.map((t) => ({ name: t.name, description: t.description })),
  }),
);

/**
 * Endpoints especificos para M5 (hackAIVoice). Mapean nuestro modelo
 * (lead + producto + papeleta) al shape que el agente de voz espera:
 *   - /voice/identify    -> sync, <100ms, para el saludo inicial Twilio.
 *   - /voice/rag-profile -> async, contexto profundo que se inyecta a
 *                            ElevenLabs como system_message a los ~2.5s.
 *
 * Aceptan ambos: phone (caller ID Twilio) o lead_id (UUID interno).
 * tenant_slug opcional, default "acme".
 */
app.post("/voice/identify", async (c) => {
  let body: { tenant_slug?: string; phone?: string; lead_id?: string; from?: string } = {};
  try {
    body = await c.req.json();
  } catch {}
  try {
    const identity = await buildIdentity(body);
    return c.json(identity);
  } catch (err) {
    console.error("[voice/identify]", err);
    return c.json(
      {
        user_id: null,
        name: "Cliente",
        is_active_client: false,
        phone: body.phone ?? body.from ?? null,
        lead_status: "unknown",
        error: (err as Error).message,
      },
      200,
    );
  }
});

app.post("/voice/rag-profile", async (c) => {
  let body: { tenant_slug?: string; phone?: string; lead_id?: string; from?: string } = {};
  try {
    body = await c.req.json();
  } catch {}
  try {
    const profile = await buildRagProfile(body);
    if (!profile) return c.json({ error: "lead no encontrado" }, 404);
    return c.json(profile);
  } catch (err) {
    console.error("[voice/rag-profile]", err);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/tools/:name", async (c) => {
  const name = c.req.param("name");
  const def = toolDefinitions.find((t) => t.name === name);
  if (!def) return c.json({ error: `tool '${name}' no existe` }, 404);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const parsed = def.schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "args invalidos", details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await def.handler(parsed.data);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Railway inyecta PORT. Local usamos MCP_HTTP_PORT para no chocar con otros
// servicios. Hostname 0.0.0.0 explicito para garantizar binding en
// contenedores (la default de Bun ya es esa, pero mejor explicito).
const port = Number(Bun.env.PORT ?? process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 3333);
const hostname = Bun.env.HOSTNAME ?? process.env.HOSTNAME ?? "0.0.0.0";

Bun.serve({
  fetch: app.fetch,
  port,
  hostname,
});

console.log(`[mcp-http] escuchando en http://${hostname}:${port}`);
console.log(`[mcp-http] GET /tools  -  POST /tools/:name  -  POST /voice/identify  -  POST /voice/rag-profile`);
