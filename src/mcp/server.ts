import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolDefinitions } from "./tools.ts";

/**
 * MCP server stdio. Esto es lo que conectas a Cursor / Claude Desktop / cualquier
 * cliente MCP. Cada tool publica las del CRM headless de M6 + el knowhow de M3.
 */

const server = new Server(
  { name: "hack-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const def = toolDefinitions.find((t) => t.name === req.params.name);
  if (!def) {
    throw new Error(`tool '${req.params.name}' no existe`);
  }
  const parsed = def.schema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Argumentos invalidos: ${JSON.stringify(parsed.error.flatten())}`,
        },
      ],
    };
  }

  try {
    const result = await def.handler(parsed.data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `Error: ${(err as Error).message}` },
      ],
    };
  }
});

/**
 * Conversor minimalista Zod -> JSON Schema. No es exhaustivo pero cubre lo que
 * usan nuestras tools (objects, strings, numbers, enums, optionals).
 * Para mas cobertura podemos meter `zod-to-json-schema` despues.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodString) {
    const desc = schema.description;
    return desc ? { type: "string", description: desc } : { type: "string" };
  }
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...schema.options] };
  }
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return {};
  return {};
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] hack-mcp en stdio listo");
