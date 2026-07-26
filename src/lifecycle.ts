import type Database from "better-sqlite3";
import { now } from "./db.js";
import { postChat } from "./chat.js";

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
  agent_id?: string | null;
  agent_name?: string | null;
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
    // O snapshot precisa ser lido DENTRO da transação IMMEDIATE. Antes ele era
    // lido fora: entre a leitura e o commit, outro processo podia renovar o
    // heartbeat (requireActiveSession), e o sweep condenava como morta uma
    // sessão que tinha acabado de provar vida, soltando as travas dela em
    // silêncio. Com BEGIN IMMEDIATE, ou a renovação commitou antes (e o
    // snapshot a enxerga), ou ela espera o sweep terminar.
    const rows = db
      .prepare(
        "SELECT id, name, last_heartbeat, status, closed_at, agent_id FROM sessions WHERE status IN ('active','suspect')"
      )
      .all() as { id: string; name: string; last_heartbeat: number; status: SessionStatus; closed_at: number | null; agent_id: string | null }[];
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
    // Devolve as tasks antes de fechar. Sem isso elas ficavam 'in_progress'
    // para sempre (fechar_sessao marca 'pending', o auto-close não marcava
    // nada) e o painel acumulava tarefa zumbi de semanas.
    db.prepare(
      `UPDATE tasks SET status = 'pending', updated_at = ?
       WHERE status = 'in_progress' AND session_id IN (
         SELECT id FROM sessions WHERE status = 'dead' AND last_heartbeat < ?
       )`
    ).run(ts, deadThreshold);
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

  // Chamar uma ferramenta é o sinal de vida mais forte que o sistema tem.
  // Este é o ponto único por onde toda tool com session_id passa, então a
  // renovação vale para todas (antes só algumas renovavam, e um gerente que
  // usava apenas distribuir_tarefas/revisar_tarefa "morria" trabalhando).
  // Sessão marcada dead ressuscita: o processo evidentemente está vivo.
  // Travas que o sweep liberou enquanto a sessão esteve "morta" NÃO voltam
  // sozinhas (outro agente pode tê-las tomado); o dono retrava se precisar.
  const ts = now();
  const estavaMorta = row.status === "dead";
  const semNoticiasDesde = row.last_heartbeat;
  db.prepare("UPDATE sessions SET last_heartbeat = ?, status = 'active' WHERE id = ?").run(ts, row.id);
  if (row.agent_id) {
    // Restaura também o ponteiro da tarefa em andamento (o sweep o zera ao
    // marcar dead; sem isso todo ciclo falso-morto deixava o agente sem task).
    db.prepare(
      `UPDATE agents SET last_heartbeat = ?, updated_at = ?,
         status = CASE WHEN status = 'dead' THEN 'working' ELSE status END,
         current_session_id = COALESCE(current_session_id, ?),
         current_task_id = COALESCE(
           current_task_id,
           (SELECT id FROM tasks WHERE session_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1)
         )
       WHERE id = ? AND status != 'archived'`
    ).run(ts, ts, row.id, row.id, row.agent_id);
  }
  // A ressurreição não devolve travas, mas também não pode ser silenciosa:
  // avisa (uma vez por ciclo de morte) o que se soltou no período sem
  // notícias, para o agente retravar antes de editar.
  if (estavaMorta) {
    const perdidas = db.prepare(
      "SELECT DISTINCT file_path FROM locks WHERE session_id = ? AND released_at IS NOT NULL AND released_at >= ?"
    ).all(row.id, semNoticiasDesde) as { file_path: string }[];
    if (perdidas.length) {
      const min = Math.max(1, Math.round((ts - semNoticiasDesde) / 60_000));
      postChat(db, {
        sessionId: row.id,
        sessionName: row.name,
        role: row.role,
        type: "alerta",
        to: row.agent_name ?? null,
        message:
          `Sessão ${row.name} voltou após ${min}min sem notícias. ` +
          `Travas liberadas nesse período: ${perdidas.map((l) => l.file_path).join(", ")}. ` +
          `RETRAVE com travar_arquivos antes de editar esses arquivos.`,
        agentId: row.agent_id ?? null,
        agentName: row.agent_name ?? null,
      });
    }
  }
  row.last_heartbeat = ts;
  row.status = "active";
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
// Agente morto sem nenhuma notícia por 7 dias sai das listagens padrão.
// Arquivar não apaga: listar_agentes com incluir_arquivados mostra tudo.
const GC_DEAD_AGENT_MS = 7 * 24 * 60 * 60 * 1000;

export function gcOldData(db: Database.Database): { events: number; chat: number; sessions: number; tasks: number; agents: number } {
  const ts = now();
  const tx = db.transaction(() => {
    const e = db.prepare("DELETE FROM events WHERE created_at < ?").run(ts - GC_EVENTS_MS).changes;
    const c = db.prepare("DELETE FROM chat_messages WHERE created_at < ?").run(ts - GC_CHAT_MS).changes;
    const s = db.prepare(
      "DELETE FROM sessions WHERE status = 'closed' AND COALESCE(closed_at, 0) < ?"
    ).run(ts - GC_SESSIONS_MS).changes;
    // Arquiva (não apaga) agente morto há mais de 7 dias. Ele sai do painel
    // padrão mas segue no histórico; um gerente morto arquivado também libera
    // a vaga de eleição da equipe (o índice único ignora arquivados).
    const a = db.prepare(
      `UPDATE agents SET status = 'archived', updated_at = ?
       WHERE status = 'dead' AND updated_at < ?`
    ).run(ts, ts - GC_DEAD_AGENT_MS).changes;
    // Cura zumbis deixados por versões antigas: task 'in_progress' cuja
    // sessão já fechou (ou nem existe mais) volta para 'pending'.
    const t = db.prepare(
      `UPDATE tasks SET status = 'pending', updated_at = ?
       WHERE status = 'in_progress' AND (
         session_id IN (SELECT id FROM sessions WHERE status = 'closed')
         OR session_id NOT IN (SELECT id FROM sessions)
       )`
    ).run(ts).changes;
    return { events: e, chat: c, sessions: s, tasks: t, agents: a };
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
