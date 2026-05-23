import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { count, desc } from "drizzle-orm";
import { db, schema, sqlClient } from "../db/client.ts";
import { toolDefinitions } from "../mcp/tools.ts";
import { getTenantBySlug } from "../repos/tenants.repo.ts";

const TENANT_SLUG = process.env.DEFAULT_TENANT_SLUG ?? "acme";

// ---------------------------------------------------------------------------
// Helper: call any tool by name (same path as smoke.ts)
// ---------------------------------------------------------------------------

async function call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const t = toolDefinitions.find((d) => d.name === name);
  if (!t) throw new Error(`tool '${name}' no existe`);
  const parsed = t.schema.safeParse(args);
  if (!parsed.success) throw new Error(`args inválidos: ${JSON.stringify(parsed.error.flatten())}`);
  return (await t.handler(parsed.data)) as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Line = { id: number; text: string; color?: string; bold?: boolean };
let _lid = 0;

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(false);
  const [dbOk, setDbOk] = useState<boolean | null>(null);
  const [tenantSlug, setTenantSlug] = useState("");

  function push(...ls: Omit<Line, "id">[]) {
    setLines((prev) => [...prev, ...ls.map((l) => ({ ...l, id: _lid++ }))].slice(-30));
  }

  async function printStatus() {
    const [lc, cc, ec, pc] = await Promise.all([
      db.select({ c: count() }).from(schema.leads),
      db.select({ c: count() }).from(schema.knowhowChunks),
      db.select({ c: count() }).from(schema.events),
      db.select({ c: count() }).from(schema.products),
    ]);
    push(
      { text: "── status ──────────────────────────────────────────" },
      { text: `  productos ${String(pc[0]?.c ?? 0).padStart(4)}   leads   ${String(lc[0]?.c ?? 0).padStart(4)}` },
      { text: `  chunks    ${String(cc[0]?.c ?? 0).padStart(4)}   eventos ${String(ec[0]?.c ?? 0).padStart(4)}` },
      { text: "  status · products · leads · query · events · help", color: "gray" },
    );
  }

  async function init() {
    try {
      const t = await getTenantBySlug(TENANT_SLUG);
      setDbOk(true);
      if (t) setTenantSlug(t.slug);
      await printStatus();
    } catch (err) {
      setDbOk(false);
      push(
        { text: `✗ Sin DB: ${err instanceof Error ? err.message : String(err)}`, color: "red" },
        { text: "  → bun run bootstrap", color: "yellow" },
      );
    }
  }

  async function run(cmd: string) {
    const parts = cmd.trim().split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ");

    push({ text: `> ${cmd}`, color: "cyan" });

    // --- status ---
    if (command === "status") {
      await printStatus();
      return;
    }

    // --- products ---
    if (command === "products") {
      const res = await call<{
        products: Array<{ slug: string; name: string }>;
      }>("list_products", { tenant_slug: TENANT_SLUG });
      if (!res.products.length) {
        push({ text: "  sin productos — corre: seed", color: "yellow" });
        return;
      }
      push({ text: `Productos (${res.products.length}):`, bold: true });
      res.products.forEach((p) => push({ text: `  ${p.slug.padEnd(22)} ${p.name}` }));
      return;
    }

    // --- leads [status] ---
    if (command === "leads") {
      const res = await call<{
        leads: Array<{ id: string; name: string | null; phone: string | null; status: string; intent: string }>;
      }>("list_leads", { tenant_slug: TENANT_SLUG, ...(arg ? { status: arg } : {}), limit: 15 });
      if (!res.leads.length) {
        push({ text: "  sin leads.", color: "gray" });
        return;
      }
      push({ text: `Leads (${res.leads.length}):`, bold: true });
      res.leads.forEach((l) =>
        push({
          text: `  ${l.status.padEnd(14)} ${l.intent.padEnd(9)} ${(l.phone ?? "—").padEnd(16)} ${l.name ?? "sin nombre"}`,
        }),
      );
      return;
    }

    // --- lead <phone|uuid> ---
    if (command === "lead") {
      if (!arg) {
        push({ text: "  uso: lead <phone|uuid>", color: "yellow" });
        return;
      }
      const res = await call<{
        found: boolean;
        lead?: { name: string | null; status: string; intent: string; papeleta: unknown };
        product?: { name: string } | null;
        recentTranscripts?: Array<{ text: string }>;
      }>("get_lead_context", { tenant_slug: TENANT_SLUG, lead_key: arg });
      if (!res.found || !res.lead) {
        push({ text: `  '${arg}' no encontrado.`, color: "yellow" });
        return;
      }
      const pap = JSON.stringify(res.lead.papeleta, null, 2).slice(0, 100);
      push(
        { text: `Lead: ${res.lead.name ?? "sin nombre"}`, bold: true },
        { text: `  status: ${res.lead.status}   intent: ${res.lead.intent}` },
        { text: `  producto: ${res.product?.name ?? "no asignado"}` },
        { text: `  transcripts: ${res.recentTranscripts?.length ?? 0}` },
        { text: `  papeleta: ${pap}…` },
      );
      return;
    }

    // --- query <text> [@product-slug] ---
    if (command === "query") {
      if (!arg) {
        push({ text: "  uso: query <texto>  o  query <texto> @slug-producto", color: "yellow" });
        return;
      }
      const productMatch = arg.match(/@([a-z0-9-]+)$/);
      const productSlug = productMatch?.[1];
      const query = productMatch ? arg.replace(/@[a-z0-9-]+$/, "").trim() : arg;
      const res = await call<{
        chunks: Array<{ text: string; score: number; strategy: string }>;
      }>("query_knowhow", {
        tenant_slug: TENANT_SLUG,
        query,
        k: 4,
        ...(productSlug ? { product_slug: productSlug } : {}),
      });
      if (!res.chunks.length) {
        push({ text: "  sin resultados.", color: "gray" });
        return;
      }
      push({ text: `Knowhow "${query}"${productSlug ? ` @${productSlug}` : ""}:`, bold: true });
      res.chunks.forEach((c, i) =>
        push({
          text: `  ${i + 1}. [${c.score.toFixed(2)} ${c.strategy}] ${c.text.slice(0, 72)}${c.text.length > 72 ? "…" : ""}`,
        }),
      );
      return;
    }

    // --- events [n] ---
    if (command === "events") {
      const n = parseInt(arg || "10") || 10;
      const evts = await db
        .select({ type: schema.events.type, ts: schema.events.ts })
        .from(schema.events)
        .orderBy(desc(schema.events.ts))
        .limit(n);
      if (!evts.length) {
        push({ text: "  sin eventos.", color: "gray" });
        return;
      }
      push({ text: `Eventos (${evts.length}):`, bold: true });
      evts.forEach((e) =>
        push({ text: `  ${new Date(e.ts).toLocaleTimeString("es-MX")}  ${e.type}` }),
      );
      return;
    }

    // --- create <phone> [nombre] ---
    if (command === "create") {
      const [phone, ...nameParts] = parts.slice(1);
      if (!phone) {
        push({ text: "  uso: create <phone> [nombre]", color: "yellow" });
        return;
      }
      const name = nameParts.join(" ") || undefined;
      const res = await call<{ lead: { id: string } }>("create_lead", {
        tenant_slug: TENANT_SLUG,
        phone,
        ...(name ? { name } : {}),
        source: "cli",
      });
      push({ text: `  ✓ lead creado: ${res.lead.id}`, color: "green" });
      return;
    }

    // --- seed ---
    if (command === "seed") {
      push({ text: "  ejecutando seed (trunca y re-siembra)…", color: "yellow" });
      const proc = Bun.spawn([process.execPath, "run", "src/db/seed.ts"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      out
        .split("\n")
        .filter(Boolean)
        .forEach((l) => push({ text: `  ${l}`, color: code === 0 ? "green" : "red" }));
      if (code === 0) {
        const t = await getTenantBySlug(TENANT_SLUG);
        if (t) setTenantSlug(t.slug);
        await printStatus();
      }
      return;
    }

    // --- smoke ---
    if (command === "smoke") {
      push({ text: "  ejecutando smoke test…", color: "yellow" });
      const proc = Bun.spawn([process.execPath, "run", "src/scripts/smoke.ts"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      out
        .split("\n")
        .filter(Boolean)
        .forEach((l) => push({ text: `  ${l}` }));
      push({
        text: code === 0 ? "  ✓ smoke OK" : "  ✗ smoke FAIL",
        color: code === 0 ? "green" : "red",
        bold: true,
      });
      return;
    }

    // --- tools ---
    if (command === "tools") {
      push({ text: "MCP tools expuestas:", bold: true });
      toolDefinitions.forEach((t) =>
        push({ text: `  ${t.name.padEnd(22)} ${t.description.slice(0, 56)}` }),
      );
      return;
    }

    // --- help ---
    if (command === "help") {
      push(
        { text: "Comandos:", bold: true },
        { text: "  status              — estado del sistema" },
        { text: "  products            — catálogo de productos" },
        { text: "  leads [status]      — lista leads (new/profiling/assigned/hot…)" },
        { text: "  lead <phone|id>     — contexto completo del lead" },
        { text: "  create <phone>      — crear lead" },
        { text: "  query <texto>       — buscar en knowhow" },
        { text: "  query <text> @slug  — filtrar knowhow por producto" },
        { text: "  events [n]          — últimos N eventos (default 10)" },
        { text: "  tools               — lista tools MCP" },
        { text: "  seed                — truncar y re-sembrar BD" },
        { text: "  smoke               — smoke test end-to-end" },
        { text: "  q                   — salir" },
      );
      return;
    }

    // --- quit ---
    if (command === "q" || command === "quit" || command === "exit") {
      await sqlClient.end();
      exit();
      return;
    }

    if (command) {
      push({ text: `  '${command}' desconocido — escribe 'help'`, color: "yellow" });
    }
  }

  useEffect(() => {
    void init();
  }, []);

  useInput((ch, key) => {
    if (loading) return;

    if (key.return) {
      const cmd = input.trim();
      setInput("");
      if (!cmd) return;
      setLoading(true);
      run(cmd)
        .catch((err) =>
          push({ text: `  ✗ ${err instanceof Error ? err.message : String(err)}`, color: "red" }),
        )
        .finally(() => setLoading(false));
      return;
    }

    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }

    if (key.ctrl && ch === "c") {
      void sqlClient.end().finally(() => exit());
      return;
    }

    if (ch && !key.ctrl && !key.meta) {
      setInput((s) => s + ch);
    }
  });

  const dot = dbOk === null ? "○" : dbOk ? "●" : "✗";
  const dotColor = dbOk === null ? ("yellow" as const) : dbOk ? ("green" as const) : ("red" as const);
  const cols = process.stdout.columns ?? 80;
  const rule = "─".repeat(Math.max(8, cols - 2));

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="cyan">HACK M6  </Text>
        <Text color={dotColor}>{dot} </Text>
        <Text color="gray">hack@localhost:5433</Text>
        {tenantSlug ? <Text color="gray"> · tenant: {tenantSlug}</Text> : null}
      </Box>

      <Box paddingX={1}>
        <Text color="gray">{rule}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1}>
        {lines.map((l) => (
          <Text key={l.id} color={l.color} bold={l.bold ?? false}>
            {l.text}
          </Text>
        ))}
      </Box>

      <Box paddingX={1}>
        <Text color="gray">{rule}</Text>
      </Box>

      <Box paddingX={1} paddingBottom={1}>
        <Text color={loading ? "yellow" : "green"}>{loading ? "⠋ " : "> "}</Text>
        <Text>{input}</Text>
        {!loading && <Text color="gray">█</Text>}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const { waitUntilExit } = render(<App />);
await waitUntilExit();
