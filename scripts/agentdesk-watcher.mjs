#!/usr/bin/env node
// AgentDesk Watcher (real-time)
//
// Polls ~/.agentdesk/agentdesk.db rapidamente e, quando aparece evento relevante
// destinado a um agente com tmux_pane registrado, dispara `tmux send-keys` na
// pane dele para interromper o Claude Code e injetar /auto-tick (ou outro poke
// configurado). Essa interrupção é o que dá a sensação de "tempo real" — sem
// ela, o Claude só acordaria no próximo ScheduleWakeup (mínimo de 60s).
//
// Fontes de evento monitoradas:
//   1. chat_messages — pedir/passar/alerta/decisao/falar
//   2. work_items — INSERT (delegação nova) ou UPDATE de owner/status
//   3. handoffs — INSERT de handoff novo
//   4. locks — INSERT de lock conflitante com intended_files de outro agente
//
// Uso:
//   node scripts/agentdesk-watcher.mjs
//
// Background:
//   nohup node scripts/agentdesk-watcher.mjs > /tmp/agentdesk-watcher.log 2>&1 &
//
// ENV:
//   AGENTDESK_DB        — override do path do banco
//   AGENTDESK_POKE_MSG  — texto enviado pra pane (default "/auto-tick")
//   AGENTDESK_DEBOUNCE  — ms mínimo entre pokes não-urgentes pra mesma pane (default 1500)
//   AGENTDESK_POLL_MS   — intervalo de polling (default 250)
//   AGENTDESK_REQUIRE_AUTO — se "1", só poka agentes com auto_mode=1 (legado)
//   AGENTDESK_VERBOSE   — qualquer valor pra log verboso

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { watch } from "node:fs";

const DB_PATH = process.env.AGENTDESK_DB ?? join(homedir(), ".agentdesk", "agentdesk.db");
const POKE_MSG = process.env.AGENTDESK_POKE_MSG ?? "/auto-tick";
const DEBOUNCE_MS = parseInt(process.env.AGENTDESK_DEBOUNCE ?? "1500", 10);
const POLL_MS = parseInt(process.env.AGENTDESK_POLL_MS ?? "250", 10);
const REQUIRE_AUTO = process.env.AGENTDESK_REQUIRE_AUTO === "1";
const VERBOSE = !!process.env.AGENTDESK_VERBOSE;

const log = (...args) => {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
};
const debug = (...args) => VERBOSE && log("debug:", ...args);

function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Cache de panes válidas — refresh sob demanda quando send-keys falha.
let panesCache = new Set();
let panesCacheAt = 0;
const PANES_TTL_MS = 5000;

function refreshPanes() {
  try {
    const out = execFileSync("tmux", ["list-panes", "-aF", "#{pane_id}"], { encoding: "utf8" });
    panesCache = new Set(out.split("\n").map((p) => p.trim()).filter(Boolean));
    panesCacheAt = Date.now();
  } catch {
    panesCache = new Set();
  }
}

function paneExists(pane) {
  if (Date.now() - panesCacheAt > PANES_TTL_MS) refreshPanes();
  return panesCache.has(pane);
}

function sendKeys(pane, text) {
  try {
    // -l (literal) evita interpretação de chaves especiais; Enter separado.
    execFileSync("tmux", ["send-keys", "-t", pane, "-l", text], { stdio: "ignore" });
    execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], { stdio: "ignore" });
    return true;
  } catch (e) {
    debug("falhou send-keys:", pane, e.message);
    return false;
  }
}

function targetFilter() {
  return REQUIRE_AUTO
    ? "auto_mode = 1 AND status NOT IN ('archived','dead')"
    : "tmux_pane IS NOT NULL AND status NOT IN ('archived','dead')";
}

class Poker {
  constructor() {
    this.lastByPane = new Map();
  }

  // urgent: pula debounce.
  poke(target, reason, urgent) {
    if (!target.tmux_pane) return false;
    if (!urgent) {
      const last = this.lastByPane.get(target.tmux_pane) ?? 0;
      if (Date.now() - last < DEBOUNCE_MS) {
        debug("debounce:", target.name, target.tmux_pane);
        return false;
      }
    }
    if (!paneExists(target.tmux_pane)) {
      debug("pane sumiu:", target.tmux_pane);
      return false;
    }
    if (!sendKeys(target.tmux_pane, POKE_MSG)) return false;
    this.lastByPane.set(target.tmux_pane, Date.now());
    log(`▶ poke ${target.name}/${target.role}  pane=${target.tmux_pane}  motivo=${reason}${urgent ? " URGENTE" : ""}`);
    return true;
  }
}

function resolveTargets(db, to_target) {
  if (!to_target) return [];
  // Match por nome OU por cargo, dedupe por id.
  const rows = db
    .prepare(
      `SELECT id, name, role, tmux_pane FROM agents
       WHERE (name = ? OR role = ?) AND ${targetFilter()}`
    )
    .all(to_target, to_target);
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function broadcastTargets(db) {
  return db
    .prepare(`SELECT id, name, role, tmux_pane FROM agents WHERE ${targetFilter()}`)
    .all();
}

function main() {
  if (!tmuxAvailable()) {
    console.error("tmux não está disponível. Watcher não funciona sem ele.");
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  log(`Watcher iniciado. DB=${DB_PATH}  poke="${POKE_MSG}"  poll=${POLL_MS}ms  debounce=${DEBOUNCE_MS}ms  require_auto=${REQUIRE_AUTO}`);
  refreshPanes();

  // Cursores: nunca disparar histórico — partimos do max(created_at) de cada tabela.
  let chatCursor = (db.prepare("SELECT MAX(created_at) AS m FROM chat_messages").get())?.m ?? 0;
  let workItemCursor = (db.prepare("SELECT MAX(updated_at) AS m FROM work_items").get())?.m ?? 0;
  let handoffCursor = (db.prepare("SELECT MAX(created_at) AS m FROM handoffs").get())?.m ?? 0;
  const poker = new Poker();

  const tick = () => {
    try {
      // ─── 1. Chat messages ──────────────────────────────────────────
      const newMsgs = db
        .prepare(
          `SELECT id, created_at, agent_id, agent_name, role, type, to_target, message
           FROM chat_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
        )
        .all(chatCursor);

      for (const m of newMsgs) {
        if (m.created_at > chatCursor) chatCursor = m.created_at;

        const isDono = m.role === "dono";
        const isUrgent =
          isDono ||
          m.type === "alerta" ||
          (m.type === "decisao" && m.role === "gerente") ||
          (m.type === "passar" && !!m.to_target);

        // Tipos que sequer disparam poke.
        if (!isDono && !["pedir", "passar", "alerta", "decisao", "falar"].includes(m.type)) continue;

        let targets;
        if (m.to_target) {
          targets = resolveTargets(db, m.to_target);
        } else if (isDono || (m.type === "alerta" && m.role === "gerente")) {
          targets = broadcastTargets(db);
        } else {
          continue; // mensagem geral sem destinatário e sem urgência: não acorda ninguém
        }

        const sentPanes = new Set();
        for (const t of targets) {
          if (!t.tmux_pane) continue;
          if (t.id === m.agent_id) continue; // não cutuca o autor
          if (sentPanes.has(t.tmux_pane)) continue;
          sentPanes.add(t.tmux_pane);
          poker.poke(
            t,
            `chat.${m.type} de ${isDono ? "Eduardo" : (m.agent_name ?? m.role)}`,
            isUrgent
          );
        }
      }

      // ─── 2. Work items (delegação ou mudança de status) ────────────
      const newItems = db
        .prepare(
          `SELECT id, title, status, priority, assigned_to, assigned_role,
                  owner_agent_id, owner_agent_name, updated_at, created_at
           FROM work_items
           WHERE updated_at > ?
           ORDER BY updated_at ASC LIMIT 50`
        )
        .all(workItemCursor);

      for (const w of newItems) {
        if (w.updated_at > workItemCursor) workItemCursor = w.updated_at;

        // Aciona poke quando o item está esperando alguém pegar/agir:
        //  - queued: alguém precisa assumir
        //  - blocked: dono precisa olhar
        //  - review: gerente/qa precisa revisar
        // Para items "working" silenciosamente atualizados não pokamos.
        if (!["queued", "blocked", "review"].includes(w.status)) continue;

        const urgent = w.priority === "critica" || w.priority === "alta" || w.status === "review";
        let targets = [];
        if (w.status === "review") {
          // qa e gerente
          targets = db
            .prepare(
              `SELECT id, name, role, tmux_pane FROM agents
               WHERE role IN ('qa','gerente') AND ${targetFilter()}`
            )
            .all();
        } else {
          const want = w.assigned_to || w.assigned_role || w.owner_agent_name;
          if (want) targets = resolveTargets(db, want);
        }

        const sentPanes = new Set();
        for (const t of targets) {
          if (!t.tmux_pane) continue;
          if (sentPanes.has(t.tmux_pane)) continue;
          sentPanes.add(t.tmux_pane);
          poker.poke(t, `work_item.${w.status} (${w.priority})`, urgent);
        }
      }

      // ─── 3. Handoffs ───────────────────────────────────────────────
      const newHandoffs = db
        .prepare(
          `SELECT id, from_session, to_target, task_id, created_at
           FROM handoffs WHERE created_at > ? AND accepted = 0
           ORDER BY created_at ASC LIMIT 20`
        )
        .all(handoffCursor);

      for (const h of newHandoffs) {
        if (h.created_at > handoffCursor) handoffCursor = h.created_at;
        const targets = resolveTargets(db, h.to_target);
        const sentPanes = new Set();
        for (const t of targets) {
          if (!t.tmux_pane) continue;
          if (sentPanes.has(t.tmux_pane)) continue;
          sentPanes.add(t.tmux_pane);
          poker.poke(t, `handoff de task=${h.task_id}`, true);
        }
      }
    } catch (e) {
      log("erro no tick:", e.message);
    }
  };

  // Polling base: fallback / catch-up se fs.watch perder evento.
  setInterval(tick, POLL_MS);
  tick();

  // fs.watch no DIRETÓRIO do banco: cada commit do MCP escreve no -wal e no
  // -shm, gerando eventos rename/change. Ganhamos latência sub-50ms ao
  // disparar tick na hora — sem update_hook nativo (que não cruza conexões
  // em better-sqlite3). Watch no diretório (em vez do arquivo) sobrevive a
  // checkpoint TRUNCATE, que recria o -wal.
  const dbDir = dirname(DB_PATH);
  const dbBase = basename(DB_PATH);
  let pendingTick = null;
  const scheduleImmediateTick = () => {
    if (pendingTick) return;
    pendingTick = setTimeout(() => {
      pendingTick = null;
      tick();
    }, 30);
  };
  try {
    watch(dbDir, { persistent: true }, (_evt, filename) => {
      if (!filename) return;
      if (filename === `${dbBase}-wal` || filename === `${dbBase}-shm` || filename === `${dbBase}-journal`) {
        scheduleImmediateTick();
      }
    });
    log(`fs.watch ativo em ${dbDir} — latência típica <50ms`);
  } catch (e) {
    log(`fs.watch falhou em ${dbDir} (${e.message}). Usando só polling ${POLL_MS}ms.`);
  }

  const shutdown = () => {
    log("Encerrando watcher.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
