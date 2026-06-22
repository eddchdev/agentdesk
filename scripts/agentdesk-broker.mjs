#!/usr/bin/env node
// AgentDesk Broker (WebSocket push, real-time).
//
// Substitui o polling antigo por push direto do MCP server. Latência alvo:
// <50ms end-to-end (write no DB → tmux send-keys na pane).
//
// Arquitetura:
//   - Servidor WebSocket local em ws://127.0.0.1:PORT
//   - Cada MCP server abre uma conexão (lazy) e envia notify após cada escrita.
//   - O broker mantém DB em readonly só pra resolver alvos (nome/cargo →
//     tmux_pane).
//   - Recebe notify → resolve alvos → tmux send-keys.
//   - Fallback: se o broker cair, MCP server enfileira no outbox; ao reconectar,
//     drena. fs.watch continua opcional como salvaguarda.
//
// Uso:
//   nohup node scripts/agentdesk-broker.mjs > /tmp/agentdesk-broker.log 2>&1 &
//
// ENV:
//   AGENTDESK_BROKER_PORT   default 8787
//   AGENTDESK_DB            default ~/.agentdesk/agentdesk.db
//   AGENTDESK_POKE_MSG      default "/auto-tick"
//   AGENTDESK_DEBOUNCE_MS   default 800 (urgentes ignoram)
//   AGENTDESK_REQUIRE_AUTO  "1" pra exigir auto_mode=1 (legacy)
//   AGENTDESK_VERBOSE       qualquer valor
//   AGENTDESK_NO_FS_WATCH   "1" desabilita fallback fs.watch

import { WebSocketServer } from "ws";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { watch, existsSync, readdirSync, statSync, rmSync } from "node:fs";

const PORT = parseInt(process.env.AGENTDESK_BROKER_PORT ?? "8787", 10);
const DB_PATH = process.env.AGENTDESK_DB ?? join(homedir(), ".agentdesk", "agentdesk.db");
const POKE_MSG = process.env.AGENTDESK_POKE_MSG ?? "/auto-tick";
const DEBOUNCE_MS = parseInt(process.env.AGENTDESK_DEBOUNCE_MS ?? "800", 10);
const REQUIRE_AUTO = process.env.AGENTDESK_REQUIRE_AUTO === "1";
const VERBOSE = !!process.env.AGENTDESK_VERBOSE;
const NO_FS_WATCH = process.env.AGENTDESK_NO_FS_WATCH === "1";

const log = (...args) => {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
};
const debug = (...args) => VERBOSE && log("debug:", ...args);

function tmuxAvailable() {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

let panesCache = new Set();
let panesAt = 0;
const PANES_TTL = 5000;
function refreshPanes() {
  try {
    const out = execFileSync("tmux", ["list-panes", "-aF", "#{pane_id}"], { encoding: "utf8" });
    panesCache = new Set(out.split("\n").map((p) => p.trim()).filter(Boolean));
    panesAt = Date.now();
  } catch {
    panesCache = new Set();
  }
}
function paneOk(pane) {
  if (Date.now() - panesAt > PANES_TTL) refreshPanes();
  return panesCache.has(pane);
}

function sendKeys(pane, text) {
  try {
    execFileSync("tmux", ["send-keys", "-t", pane, "-l", text], { stdio: "ignore" });
    execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], { stdio: "ignore" });
    return true;
  } catch (e) {
    debug("send-keys falhou:", pane, e.message);
    return false;
  }
}

const lastPoke = new Map();

function poke(target, reason, urgent) {
  if (!target?.tmux_pane) return false;
  if (!urgent) {
    const last = lastPoke.get(target.tmux_pane) ?? 0;
    if (Date.now() - last < DEBOUNCE_MS) {
      debug("debounce:", target.name, target.tmux_pane);
      return false;
    }
  }
  if (!paneOk(target.tmux_pane)) {
    debug("pane sumiu:", target.tmux_pane);
    return false;
  }
  if (!sendKeys(target.tmux_pane, POKE_MSG)) return false;
  lastPoke.set(target.tmux_pane, Date.now());
  log(`▶ ${target.name}/${target.role}  pane=${target.tmux_pane}  motivo=${reason}${urgent ? " URGENTE" : ""}`);
  return true;
}

function targetFilter() {
  return REQUIRE_AUTO
    ? "auto_mode = 1 AND status NOT IN ('archived','dead')"
    : "tmux_pane IS NOT NULL AND status NOT IN ('archived','dead')";
}

function resolveTargets(db, who) {
  if (!who) return [];
  const rows = db
    .prepare(`SELECT id, name, role, tmux_pane FROM agents WHERE (name = ? OR role = ?) AND ${targetFilter()}`)
    .all(who, who);
  const seen = new Set();
  return rows.filter((r) => seen.has(r.id) ? false : (seen.add(r.id), true));
}

function broadcastTargets(db) {
  return db.prepare(`SELECT id, name, role, tmux_pane FROM agents WHERE ${targetFilter()}`).all();
}

function processNotify(db, n) {
  let targets = [];
  let urgent = !!n.urgent;
  let reason = `${n.kind}.${n.type ?? "?"}`;

  switch (n.kind) {
    case "chat": {
      if (n.to) {
        targets = resolveTargets(db, n.to);
      } else if (n.type === "alerta" || n.from_role === "gerente" || n.from_role === "dono") {
        // Broadcast de dono/gerente OU alerta: acorda time todo.
        targets = broadcastTargets(db);
        urgent = true;
      } else if (n.from_role && n.from_role !== "gerente" && n.from_role !== "dono") {
        // Broadcast de subordinado: acorda só gerentes (resposta sobe).
        targets = resolveTargets(db, "gerente");
      }
      if (n.type === "alerta" || n.type === "passar") urgent = true;
      if (n.from_role === "gerente" && (n.type === "decisao" || n.type === "pedir" || n.type === "falar")) urgent = true;
      break;
    }
    case "work_item": {
      if (n.to) targets = resolveTargets(db, n.to);
      if (n.priority === "critica" || n.priority === "alta") urgent = true;
      if (n.type === "delivered") {
        // entrega para review → notifica qa e gerente
        targets = db
          .prepare(`SELECT id, name, role, tmux_pane FROM agents WHERE role IN ('qa','gerente') AND ${targetFilter()}`)
          .all();
        urgent = true;
      }
      break;
    }
    case "handoff": {
      if (n.to) targets = resolveTargets(db, n.to);
      urgent = true;
      break;
    }
    case "lock":
    case "agent":
    default:
      return;
  }

  const sentPanes = new Set();
  for (const t of targets) {
    if (!t.tmux_pane) continue;
    if (n.from_agent_id && t.id === n.from_agent_id) continue;
    if (sentPanes.has(t.tmux_pane)) continue;
    sentPanes.add(t.tmux_pane);
    poke(t, reason, urgent);
  }
}

function main() {
  if (!tmuxAvailable()) {
    console.error("tmux indisponível. O broker continua aceitando notifies pra debug, mas não acorda ninguém.");
  } else {
    refreshPanes();
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  log(`Broker iniciado. ws://127.0.0.1:${PORT}  DB=${DB_PATH}  poke="${POKE_MSG}"  debounce=${DEBOUNCE_MS}ms`);

  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  let clients = 0;
  wss.on("connection", (ws) => {
    clients++;
    debug(`cliente conectou (${clients} total)`);
    ws.on("message", (raw) => {
      try {
        const n = JSON.parse(raw.toString());
        processNotify(db, n);
      } catch (e) {
        debug("payload inválido:", e.message);
      }
    });
    ws.on("close", () => {
      clients--;
      debug(`cliente saiu (${clients} restantes)`);
    });
  });

  // Fallback fs.watch (caso o MCP server não consiga conectar no broker e
  // alguém escreva no DB por fora).
  if (!NO_FS_WATCH) {
    const dbDir = dirname(DB_PATH);
    const dbBase = basename(DB_PATH);
    let chatCursor = (db.prepare("SELECT MAX(created_at) AS m FROM chat_messages").get())?.m ?? 0;
    let workCursor = (db.prepare("SELECT MAX(updated_at) AS m FROM work_items").get())?.m ?? 0;
    let handoffCursor = (db.prepare("SELECT MAX(created_at) AS m FROM handoffs").get())?.m ?? 0;
    let pending = null;
    const drain = () => {
      pending = null;
      try {
        const newChats = db.prepare(
          `SELECT id, created_at, agent_id, agent_name, role, type, to_target
           FROM chat_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 100`
        ).all(chatCursor);
        for (const m of newChats) {
          if (m.created_at > chatCursor) chatCursor = m.created_at;
          processNotify(db, {
            kind: "chat", type: m.type, to: m.to_target, from_agent_id: m.agent_id,
            urgent: m.type === "alerta" || m.type === "passar",
            message_id: m.id,
          });
        }
        const newItems = db.prepare(
          `SELECT id, status, priority, assigned_to, assigned_role, updated_at
           FROM work_items WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 50`
        ).all(workCursor);
        for (const w of newItems) {
          if (w.updated_at > workCursor) workCursor = w.updated_at;
          if (!["queued", "blocked", "review"].includes(w.status)) continue;
          processNotify(db, {
            kind: "work_item",
            type: w.status === "review" ? "delivered" : w.status,
            to: w.assigned_to || w.assigned_role,
            priority: w.priority,
            urgent: w.priority === "critica" || w.priority === "alta" || w.status === "review",
            work_item_id: w.id,
          });
        }
        const newHandoffs = db.prepare(
          `SELECT id, to_target, created_at FROM handoffs WHERE created_at > ? AND accepted = 0 ORDER BY created_at ASC LIMIT 20`
        ).all(handoffCursor);
        for (const h of newHandoffs) {
          if (h.created_at > handoffCursor) handoffCursor = h.created_at;
          processNotify(db, { kind: "handoff", to: h.to_target, urgent: true });
        }
      } catch (e) {
        debug("drain erro:", e.message);
      }
    };
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(drain, 30);
    };
    try {
      watch(dbDir, { persistent: true }, (_evt, fn) => {
        if (!fn) return;
        if (fn === `${dbBase}-wal` || fn === `${dbBase}-shm`) schedule();
      });
      log(`fs.watch fallback ativo em ${dbDir}`);
    } catch (e) {
      log(`fs.watch fallback indisponível: ${e.message}`);
    }
  }

  // GC de worktrees abandonadas em /tmp/agentdesk-worktrees (a cada 6h).
  // Conservador: só remove dirs sem atividade há mais de 7 dias.
  const WORKTREE_ROOT = "/tmp/agentdesk-worktrees";
  const WORKTREE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const gcWorktrees = () => {
    if (!existsSync(WORKTREE_ROOT)) return;
    const now = Date.now();
    let removed = 0;
    for (const name of readdirSync(WORKTREE_ROOT)) {
      const full = join(WORKTREE_ROOT, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > WORKTREE_TTL_MS) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
      } catch { /* skip */ }
    }
    if (removed) log(`gc worktrees: ${removed} removidas`);
  };
  setInterval(gcWorktrees, 6 * 60 * 60 * 1000).unref?.();
  setTimeout(gcWorktrees, 5_000); // primeira passada no startup

  const shutdown = () => {
    log("Encerrando broker.");
    wss.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
