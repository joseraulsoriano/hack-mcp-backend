# HACK - Modulos 3 (Knowhow/RAG) y 6 (Datos/CRM/MCP)

Servidor MCP "headless" sobre Postgres + pgvector. Cualquier modulo (M1, M2, M4, M5)
o cliente externo (Cursor, n8n, Salesforce, tu front) consume estas tools para
alimentarse del CRM y del knowhow de la empresa.

## Stack

- Bun + TypeScript
- Postgres 16 con `pgvector` y `pg_trgm` (via Docker)
- Drizzle ORM + `drizzle-kit` (SQL-first, sin codegen pesado)
- Hono + `@modelcontextprotocol/sdk` para el server MCP (stdio + HTTP)
- OpenAI embeddings opcionales (fallback automatico a trigram)

## Bootstrap en un comando

```bash
cp .env.example .env
bun install
bun run bootstrap
```

`bootstrap` levanta Postgres, corre migraciones y seedea el tenant `acme` con
2 productos y su knowhow.

## Comandos del dia a dia

| Comando | Que hace |
|---|---|
| `bun run db:up` | Levanta solo el Postgres |
| `bun run db:reset` | Borra el volumen y vuelve a levantar limpio |
| `bun run db:psql` | Abre psql contra la DB en Docker |
| `bun run db:generate` | Genera SQL de migracion a partir del schema |
| `bun run db:migrate` | Aplica migraciones |
| `bun run db:seed` | Reseedea tenant + productos + knowhow |
| `bun run db:studio` | UI web de Drizzle Studio |
| `bun run smoke` | Ejercita todas las tools del MCP en una corrida |
| `bun run mcp` | Inicia el servidor MCP en stdio (para Cursor) |
| `bun run mcp:http` | Inicia el servidor MCP como HTTP (puerto 3333) |

## Flujo de cambios en el schema

1. Editar `src/db/schema.ts`.
2. `bun run db:generate` -> crea SQL en `./drizzle/`.
3. `bun run db:migrate` -> aplica.
4. `bun run db:seed` si necesitas datos frescos.

## Tools que expone el MCP (M3 + M6)

| Tool | Modulo | Uso |
|---|---|---|
| `list_products` | M6 | Catalogo del tenant |
| `list_leads` | M6 | Listado con filtros por estado/producto |
| `get_lead_context` | M6 | Papeleta + producto + transcripts + conversaciones |
| `create_lead` | M6 | Crear lead, opcionalmente con transcript inicial |
| `update_papeleta` | M6 | Usado por M2 (Perfilador) tras procesar el transcript |
| `query_knowhow` | M3 | Busqueda vectorial (pgvector) o trigram, filtrable por producto |

## Embeddings opcionales

Si pones `OPENAI_API_KEY`, el seed y `query_knowhow` usan
`text-embedding-3-small` y pgvector con index HNSW + cosine.

Si no la pones, todo sigue funcionando con `pg_trgm` y similaridad por trigram.
Esto deja arrancar HOY sin API key y subir calidad cuando se conecte.

## Probar el MCP server HTTP desde curl

```bash
bun run mcp:http
# en otra terminal:
curl http://localhost:3333/tools
curl -X POST http://localhost:3333/tools/list_products \
  -H 'content-type: application/json' \
  -d '{"tenant_slug":"acme"}'
curl -X POST http://localhost:3333/tools/query_knowhow \
  -H 'content-type: application/json' \
  -d '{"tenant_slug":"acme","query":"plan starter precio","k":3}'
```

## Conectar el MCP stdio a Cursor

Agrega en `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hack": {
      "command": "bun",
      "args": ["run", "src/mcp/server.ts"],
      "cwd": "/Users/chasse/HACK",
      "env": {
        "DATABASE_URL": "postgres://hack:hack@localhost:5433/hack"
      }
    }
  }
}
```

## Layout

```
src/
  db/        schema, client, migrate, seed
  knowhow/   ingest, query, embeddings, knowhow.json semilla (M3)
  repos/     tenants, products, leads, transcripts, events (M6)
  mcp/       tools, server stdio, server http (M6)
  scripts/   smoke e2e
```
