import type Database from "better-sqlite3";
import { now } from "./db.js";

// Thresholds calibrados para acomodar o intervalo OCIOSO de 300s do auto-tick.
// Antes: SUSPECT=60s, DEAD=180s → agentes saudáveis em idle eram marcados DEAD
// antes de acordar (300s), quebrando o loop com "Sessão morta" no requireActiveSession.
export const SUSPECT_AFTER_MS = 90_000;   // 1m30s: tolerância para tick OCIOSO em andamento
export const DEAD_AFTER_MS = 360_000;     // 6min: acomoda OCIOSO=300s + buffer de 60s

export type SessionStatus = "active" | "suspect" | "dead" | "closed";

export interface SessionRow {
  id: string;
  name: string;
  role: string;
  task: string | null;
  project: string | null;
  folder: string | null;
  areas: string | null;
  intended_files: string | null;
  opened_at: number;
  last_heartbeat: number;
  status: SessionStatus;
  closed_at: number | null;
}

export function deriveStatus(row: { last_heartbeat: number; status: SessionStatus; closed_at: number | null }): SessionStatus {
  if (row.status === "closed" || row.closed_at) return "closed";
  const age = now() - row.last_heartbeat;
  if (age >= DEAD_AFTER_MS) return "dead";
  if (age >= SUSPECT_AFTER_MS) return "suspect";
  return "active";
}

// Sessões dead mais antigas que esse threshold são fechadas. 30min dá folga pra
// retomar agentes que ficaram em pausa sem fechar (ex: usuário fechou laptop).
export const AUTO_CLOSE_AFTER_MS = 30 * 60_000;

export function sweepSessions(db: Database.Database): { marked_dead: string[]; released_locks: number } {
  const rows = db
    .prepare(
      "SELECT id, name, last_heartbeat, status, closed_at, agent_id FROM sessions WHERE status IN ('active','suspect')"
    )
    .all() as { id: string; name: string; last_heartbeat: number; status: SessionStatus; closed_at: number | null; agent_id: string | null }[];

  const markedDead: string[] = [];
  const updateStatus = db.prepare("UPDATE sessions SET status = ? WHERE id = ?");
  const releaseLocks = db.prepare(
    "UPDATE locks SET released_at = ? WHERE session_id = ? AND released_at IS NULL"
  );
  // Quando sessão morre, agente vai pra 'dead' e ZERA current_session_id E
  // current_task_id — senão restaurar_contexto e retomar_agente tentam
  // ressuscitar uma task antiga e dão null pointer.
  const updateAgent = db.prepare(
    "UPDATE agents SET status = 'dead', updated_at = ?, current_session_id = NULL, current_task_id = NULL WHERE id = ? AND status = 'working'"
  );

  let releasedTotal = 0;
  const ts = now();

  const tx = db.transaction(() => {
    for (const r of rows) {
      const newStatus = deriveStatus(r);
      if (newStatus !== r.status) {
        updateStatus.run(newStatus, r.id);
      }
      if (newStatus === "dead") {
        const info = releaseLocks.run(ts, r.id);
        releasedTotal += info.changes;
        markedDead.push(r.name);
        if (r.agent_id) {
          updateAgent.run(ts, r.agent_id);
        }
      }
    }

    // Auto-close: sessions dead há mais de AUTO_CLOSE_AFTER_MS
    // Mantém o agente (persistente) mas limpa a session do histórico visível.
    const deadThreshold = ts - AUTO_CLOSE_AFTER_MS;
    db.prepare(
      `UPDATE sessions SET status = 'closed', closed_at = ?
       WHERE status = 'dead' AND last_heartbeat < ?`
    ).run(ts, deadThreshold);
  });
  tx.immediate();

  return { marked_dead: markedDead, released_locks: releasedTotal };
}

export function requireActiveSession(db: Database.Database, sessionId: string): SessionRow {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) throw new Error(`Sessão ${sessionId} não encontrada. Use /abrir antes.`);
  const status = deriveStatus(row);
  if (status === "closed") throw new Error(`Sessão ${row.name} já foi fechada.`);
  if (status === "dead") throw new Error(`Sessão ${row.name} foi marcada como morta (sem heartbeat). Abra uma nova com /abrir.`);
  return row;
}

// GC de dados antigos. Chamado periodicamente (sweep ou broker).
// - events: > 7 dias (audit log barato de regenerar)
// - chat_messages: > 30 dias (mantém histórico mais longo)
// - sessions closed: > 60 dias (já tem agente persistente, sessão é histórico)
// Conservador: nunca apaga agentes nem work_items.
const GC_EVENTS_MS = 7 * 24 * 60 * 60 * 1000;
const GC_CHAT_MS = 30 * 24 * 60 * 60 * 1000;
const GC_SESSIONS_MS = 60 * 24 * 60 * 60 * 1000;

export function gcOldData(db: Database.Database): { events: number; chat: number; sessions: number } {
  const ts = now();
  const tx = db.transaction(() => {
    const e = db.prepare("DELETE FROM events WHERE created_at < ?").run(ts - GC_EVENTS_MS).changes;
    const c = db.prepare("DELETE FROM chat_messages WHERE created_at < ?").run(ts - GC_CHAT_MS).changes;
    const s = db.prepare(
      "DELETE FROM sessions WHERE status = 'closed' AND COALESCE(closed_at, 0) < ?"
    ).run(ts - GC_SESSIONS_MS).changes;
    return { events: e, chat: c, sessions: s };
  });
  return tx.immediate() as any;
}

export function recordEvent(db: Database.Database, sessionId: string | null, type: string, payload: unknown) {
  db.prepare(
    "INSERT INTO events (id, created_at, session_id, type, payload) VALUES (?, ?, ?, ?, ?)"
  ).run(
    cryptoRandom(),
    now(),
    sessionId,
    type,
    payload == null ? null : JSON.stringify(payload)
  );
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
