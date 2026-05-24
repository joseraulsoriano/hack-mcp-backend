# Image oficial de Bun
FROM oven/bun:1-alpine

WORKDIR /app

# Instalar dependencias
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copiar codigo
COPY . .

# Railway inyecta PORT
EXPOSE 3000

# Comando de inicio: Corre migraciones, seed y luego el server. 
# Usamos exec para que las señales de Railway lleguen al proceso.
CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/db/seed.ts && bun src/mcp/http.ts"]
