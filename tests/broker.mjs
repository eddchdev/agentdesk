#!/usr/bin/env node
// Teste E2E do broker WebSocket.
//
// Sobe broker numa porta isolada + 1 MCP server apontando pro broker, manda
// pedir_acao e valida que o broker recebeu o notify (sem precisar de tmux real).
// Faz isso interceptando o broker via env AGENTDESK_NO_FS_WATCH e
// AGENTDESK_BROKER_PORT.

import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCP_BIN = resolve(import.meta.dirname, "../dist/index.js");
const DB_DIR = mkdtempSync(join(tmpdir(), "agentdesk-broker-"));
const DB_PATH = join(DB_DIR, "agentdesk.db");
const PORT = 18800 + Math.floor(Math.random() * 100);

const env = {
  ...process.env,
  AGENTDESK_DB: DB_PATH,
  AGENTDESK_BROKER_URL: `ws://127.0.0.1:${PORT}`,
  HOME: DB_DIR,
};

const cleanup = () => rmSync(DB_DIR, { recursive: true, force: true });

async function run() {
  console.log(`\n=== Broker WS test (DB=${DB_PATH}  port=${PORT}) ===\n`);

  // ─── 1. Sobe um WebSocketServer fake que coleta notifies ──────────
  const received = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  wss.on("connection", (ws) => {
    console.log("  [broker-fake] cliente MCP conectou");
    ws.on("message", (raw) => {
      try {
        const n = JSON.parse(raw.toString());
        received.push(n);
        console.log(`  [broker-fake] notify: ${n.kind}/${n.type} to=${n.to} urgent=${!!n.urgent}`);
      } catch (e) {
        console.error("  [broker-fake] payload inválido:", e.message);
      }
    });
  });

  // Espera o WSS estar pronto.
  await new Promise((r) => wss.once("listening", r));

  // ─── 2. Spawn MCP server, manda algumas tools ─────────────────────
  const proc = spawn("node", [MCP_BIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`[mcp] ${d}`));

  let nextId = 1;
  const pending = new Map();
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
      } catch {}
    }
  });

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 5000);
    });

  const call = async (tool, args) => {
    const r = await rpc("tools/call", { name: tool, arguments: args });
    if (r.error) throw new Error(`${tool}: ${r.error.message}`);
    if (r.result?.isError) throw new Error(r.result.content[0].text);
    return r.result.content[0].text;
  };

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });

  const t1 = await call("abrir_ou_retornar_agente", {
    cargo: "backend", tarefa: "broker test", pasta: "/tmp/broker-e2e", force_new: true,
  });
  const sess = t1.match(/session_id:\s*([^\s]+)/)[1];
  const name = t1.match(/Agente criado: (\w+)/)[1];

  // Aguarda conexão WebSocket estabelecer.
  await new Promise((r) => setTimeout(r, 400));

  // Gera 3 eventos diferentes.
  await call("enviar_mensagem", { session_id: sess, mensagem: "geral 1" });
  await call("pedir_acao", { session_id: sess, destinatario: "qa", mensagem: "test pedir" });

  // Cria gerente em OUTRO client e delega
  const proc2 = spawn("node", [MCP_BIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  proc2.stderr.on("data", (d) => process.stderr.write(`[mcp2] ${d}`));
  let buf2 = "";
  let id2 = 1;
  const pending2 = new Map();
  proc2.stdout.setEncoding("utf8");
  proc2.stdout.on("data", (chunk) => {
    buf2 += chunk;
    let i;
    while ((i = buf2.indexOf("\n")) >= 0) {
      const line = buf2.slice(0, i).trim();
      buf2 = buf2.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); const p = pending2.get(m.id); if (p) { pending2.delete(m.id); p.resolve(m); } } catch {}
    }
  });
  const rpc2 = (method, params) => new Promise((resolve, reject) => {
    const id = id2++;
    pending2.set(id, { resolve, reject });
    proc2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending2.has(id) && (pending2.delete(id), reject(new Error("timeout"))), 5000);
  });
  await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "g", version: "0" } });
  const gR = await rpc2("tools/call", { name: "abrir_ou_retornar_agente", arguments: {
    cargo: "gerente", tarefa: "boss", pasta: "/tmp/broker-e2e-ger", force_new: true,
  }});
  const gSess = gR.result.content[0].text.match(/session_id:\s*([^\s]+)/)[1];
  const dR = await rpc2("tools/call", { name: "delegar_tarefa", arguments: {
    session_id: gSess, para: "backend", tarefa: "trabalho urgente", prioridade: "critica",
  }});
  if (dR.error || dR.result?.isError) throw new Error("delegar falhou");

  // Aguarda flush dos notifies.
  await new Promise((r) => setTimeout(r, 500));

  // ─── 3. Valida ────────────────────────────────────────────────────
  const failures = [];

  const hasChatPedir = received.some((n) => n.kind === "chat" && n.type === "pedir" && n.to === "qa");
  if (!hasChatPedir) failures.push("notify chat.pedir to=qa não chegou");

  const hasChatFalar = received.some((n) => n.kind === "chat" && n.type === "falar");
  if (!hasChatFalar) failures.push("notify chat.falar não chegou");

  const hasWorkItem = received.some((n) => n.kind === "work_item" && n.to === "backend" && n.priority === "critica");
  if (!hasWorkItem) failures.push("notify work_item crítico para backend não chegou");

  const hasUrgent = received.some((n) => n.urgent === true);
  if (!hasUrgent) failures.push("nenhuma notify marcada urgent");

  // ─── 4. Reconnect resilience: derruba broker, MCP enfileira ──────
  console.log("\n  [test] derrubando broker fake e enviando enquanto offline...");
  wss.close();
  await new Promise((r) => setTimeout(r, 200));
  await call("enviar_mensagem", { session_id: sess, mensagem: "depois do broker cair" });
  // O MCP deve continuar funcionando (não bloquear).
  const heartbeatR = await call("heartbeat", { session_id: sess });
  if (!/ok/.test(heartbeatR)) failures.push("MCP travou após broker cair");

  proc.stdin.end();
  proc.kill("SIGTERM");
  proc2.stdin.end();
  proc2.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));

  console.log("\n" + "=".repeat(50));
  console.log(`Recebidos no broker: ${received.length} notifies`);
  console.log("Tipos:", received.map((n) => `${n.kind}/${n.type ?? "?"}`).join(", "));
  console.log("=".repeat(50));

  if (failures.length === 0) {
    console.log("\n✓ Broker WS funcional. MCP push instantâneo + resiliente a queda.\n");
    cleanup();
    process.exit(0);
  } else {
    console.error("\n✗ Falhas:");
    for (const f of failures) console.error("  -", f);
    cleanup();
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("Fatal:", e);
  cleanup();
  process.exit(2);
});
