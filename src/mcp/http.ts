import { Hono } from "hono";
import { cors } from "hono/cors";
import { toolDefinitions } from "./tools.ts";

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

const port = Number(process.env.MCP_HTTP_PORT ?? 3333);

export default { fetch: app.fetch, port };
console.log(`[mcp-http] escuchando en http://localhost:${port}`);
console.log(`[mcp-http] GET /tools  -  POST /tools/:name`);
