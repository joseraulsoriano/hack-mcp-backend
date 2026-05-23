#!/usr/bin/env bash
# Orquestador local de M1 + M2/M4 + M3/M6.
#
# Levanta los tres servicios en paralelo, prefija sus logs y los apaga limpio
# con Ctrl+C. Pensado para correr en la maquina del hackathon (LAN 192.168.x.x);
# no es un docker-compose ni reemplaza a uno.
#
# Servicios:
#   M3/M6  MCP HTTP        bun run mcp:http              ->  :3333
#   M2/M4  FastAPI agentes uvicorn app.main:app          ->  :8000
#   M1     Web Glasses     vite dev                       ->  :5173
#
# Flags via env:
#   ORCH_SKIP_M1=1   no levanta el frontend Vite (util si solo quieres backends)
#   ORCH_SKIP_M2=1   no levanta el FastAPI
#   ORCH_SKIP_MCP=1  no levanta el MCP (asumes que ya esta corriendo en otra)
#   ORCH_VENV=ruta/al/venv   activa un venv de Python para M2 antes de uvicorn

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT}/.orchestrate-logs"
mkdir -p "${LOG_DIR}"

# Colores: gris para prefijo, reset.
CLR_MCP=$'\033[36m'   # cyan
CLR_M2=$'\033[33m'    # yellow
CLR_M1=$'\033[35m'    # magenta
CLR_ORCH=$'\033[32m'  # green
CLR_ERR=$'\033[31m'   # red
CLR_OFF=$'\033[0m'

PIDS=()

log_orch() { printf "%b[orchestrate]%b %s\n" "${CLR_ORCH}" "${CLR_OFF}" "$*"; }
log_err()  { printf "%b[orchestrate]%b %s\n" "${CLR_ERR}"  "${CLR_OFF}" "$*" >&2; }

# Streamer que prefija cada linea con [tag] coloreado.
prefix_stream() {
  local tag=$1
  local color=$2
  while IFS= read -r line; do
    printf "%b[%s]%b %s\n" "${color}" "${tag}" "${CLR_OFF}" "${line}"
  done
}

cleanup() {
  log_orch "apagando servicios..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  # Segundo pase: si quedaron grupos enteros, mandar SIGTERM al pgid.
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  done
  log_orch "todo apagado."
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Pre-flight: Postgres tiene que estar arriba
# ---------------------------------------------------------------------------
if ! docker ps --filter "name=hack-postgres" --format '{{.Status}}' 2>/dev/null | grep -q 'Up'; then
  log_orch "postgres no esta arriba, levantando con 'bun run db:up'..."
  ( cd "${ROOT}" && bun run db:up >/dev/null 2>&1 ) || {
    log_err "no pude levantar postgres. Revisa 'docker ps' y/o './scripts/init.sql'."
    exit 1
  }
  sleep 2
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
log_orch "LAN IP detectada: ${LAN_IP}"

# ---------------------------------------------------------------------------
# M3 + M6 - MCP HTTP server
# ---------------------------------------------------------------------------
if [[ "${ORCH_SKIP_MCP:-0}" != "1" ]]; then
  if lsof -iTCP:3333 -sTCP:LISTEN -n 2>/dev/null | grep -q LISTEN; then
    log_orch "MCP ya escucha en :3333, no levanto otra instancia (puede no tener M2_WEBHOOK_URL)"
  else
    log_orch "levantando MCP HTTP en :3333 (fan-out a M2 activo)"
    (
      cd "${ROOT}"
      # El MCP, despues de ingest_transcript, hace fire-and-forget a esta URL
      # para que M2 perfile sin que M1 sepa que M2 existe.
      export M2_WEBHOOK_URL="${M2_WEBHOOK_URL:-http://localhost:8000/webhook/transcript}"
      exec bun run mcp:http 2>&1
    ) | prefix_stream "mcp" "${CLR_MCP}" &
    PIDS+=("$!")
  fi
fi

# ---------------------------------------------------------------------------
# M2 + M4 - FastAPI agentes
# ---------------------------------------------------------------------------
if [[ "${ORCH_SKIP_M2:-0}" != "1" ]]; then
  M2_DIR="${ROOT}/M2/agentes-ventas-mcp"
  if [[ ! -d "${M2_DIR}" ]]; then
    log_err "M2 no encontrado en ${M2_DIR}, lo salto"
  elif lsof -iTCP:8000 -sTCP:LISTEN -n 2>/dev/null | grep -q LISTEN; then
    log_orch "puerto :8000 ocupado, asumo que M2 ya corre"
  else
    log_orch "levantando M2/M4 (FastAPI) en :8000"
    (
      cd "${M2_DIR}"
      if [[ -n "${ORCH_VENV:-}" && -f "${ORCH_VENV}/bin/activate" ]]; then
        # shellcheck source=/dev/null
        source "${ORCH_VENV}/bin/activate"
      fi
      # Si .env existe lo cargamos sin pisarlo desde aqui.
      [[ -f .env ]] || cp -n .env.example .env 2>/dev/null || true
      exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload 2>&1
    ) | prefix_stream "m2 " "${CLR_M2}" &
    PIDS+=("$!")
  fi
fi

# ---------------------------------------------------------------------------
# M1 - Vite dev (Glasses webapp)
# ---------------------------------------------------------------------------
if [[ "${ORCH_SKIP_M1:-0}" != "1" ]]; then
  M1_DIR="${ROOT}/M1/metaintegration"
  if [[ ! -d "${M1_DIR}" ]]; then
    log_err "M1 no encontrado en ${M1_DIR}, lo salto"
  elif lsof -iTCP:5173 -sTCP:LISTEN -n 2>/dev/null | grep -q LISTEN; then
    log_orch "puerto :5173 ocupado, asumo que M1 ya corre"
  else
    log_orch "levantando M1 (Vite) en :5173"
    (
      cd "${M1_DIR}"
      # Asegura que el .env.local apunte al MCP correcto (LAN o localhost).
      if [[ -f .env.local ]]; then
        if grep -q "^VITE_MCP_URL=" .env.local; then
          # macOS sed: -i ''
          sed -i.bak "s|^VITE_MCP_URL=.*|VITE_MCP_URL=http://${LAN_IP}:3333|" .env.local
          rm -f .env.local.bak
        else
          printf "\nVITE_MCP_URL=http://%s:3333\n" "${LAN_IP}" >> .env.local
        fi
      fi
      if command -v pnpm >/dev/null 2>&1; then
        exec pnpm dev --host 0.0.0.0 --strictPort 2>&1
      else
        exec npm run dev -- --host 0.0.0.0 --strictPort 2>&1
      fi
    ) | prefix_stream "m1 " "${CLR_M1}" &
    PIDS+=("$!")
  fi
fi

# ---------------------------------------------------------------------------
# Espera a que esten healthy y reporta
# ---------------------------------------------------------------------------
wait_for_url() {
  local url=$1 name=$2 timeout=${3:-30}
  local i=0
  while (( i < timeout )); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      log_orch "${name} OK -> ${url}"
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  log_err "${name} no respondio a ${url} en ${timeout}s"
  return 1
}

sleep 2
[[ "${ORCH_SKIP_MCP:-0}" == "1" ]] || wait_for_url "http://localhost:3333/health"  "MCP "  30 || true
[[ "${ORCH_SKIP_M2:-0}"  == "1" ]] || wait_for_url "http://localhost:8000/health"  "M2/M4" 30 || true
[[ "${ORCH_SKIP_M1:-0}"  == "1" ]] || wait_for_url "http://localhost:5173"         "M1  "  30 || true

cat <<EOF

${CLR_ORCH}====================================================================${CLR_OFF}
${CLR_ORCH} HACK orquesta lista${CLR_OFF}
${CLR_ORCH}====================================================================${CLR_OFF}
  MCP    http://localhost:3333  ·  http://${LAN_IP}:3333
  M2/M4  http://localhost:8000  ·  /webhook/transcript  /expert/chat  /docs
  M1     http://localhost:5173  ·  http://${LAN_IP}:5173

  bun run orchestra:check   ->  end-to-end smoke (M1 -> MCP -> M2 -> M4)
  Ctrl+C                    ->  apaga los tres
EOF

wait
