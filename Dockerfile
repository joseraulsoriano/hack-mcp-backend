# Image oficial de Bun. La etiqueta major-version evita sorpresas en minor.
FROM oven/bun:1-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ----- stage final ---------------------------------------------------------
FROM oven/bun:1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copiamos node_modules ya resueltos y luego el codigo. Esto permite cachear
# las deps cuando solo cambia el src/.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Railway inyecta su propio PORT pero el server lo respeta via env. El expose
# es solo documental.
EXPOSE 3333

# El boot corre migraciones primero (drizzle es idempotente) y luego levanta
# el HTTP server. Si la migracion falla, el contenedor muere y Railway lo
# reinicia con backoff, lo que da visibilidad clara en logs.
CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/mcp/http.ts"]
