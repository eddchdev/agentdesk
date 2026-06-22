import type Database from "better-sqlite3";
import { newId } from "./ids.js";
import { now } from "./db.js";
import { notify } from "./notifier.js";

export type ChatType = "falar" | "pedir" | "passar" | "alerta" | "decisao" | "erro";

export interface ChatRow {
  id: string;
  created_at: number;
  session_id: string;
  session_name: string;
  role: string;
  type: ChatType;
  to_target: string | null;
  task_id: string | null;
  files: string | null;
  message: string;
  agent_id: string | null;
  agent_name: string | null;
}

export interface PostChat {
  sessionId: string;
  sessionName: string;
  role: string;
  type: ChatType;
  to?: string | null;
  taskId?: string | null;
  files?: string[] | null;
  message: string;
  agentId?: string | null;
  agentName?: string | null;
  // Quando true: insere no chat mas NÃO dispara notify pro broker. Usado em
  // fluxos que já emitem notify por outro caminho (delegar_tarefa) — evita
  // double-poke do mesmo evento.
  silent?: boolean;
}

export function postChat(db: Database.Database, p: PostChat): ChatRow {
  const id = newId();
  const ts = now();
  db.prepare(
    `INSERT INTO chat_messages
     (id, created_at, session_id, session_name, role, type, to_target, task_id, files, message, agent_id, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    ts,
    p.sessionId,
    p.sessionName,
    p.role,
    p.type,
    p.to ?? null,
    p.taskId ?? null,
    p.files && p.files.length ? JSON.stringify(p.files) : null,
    p.message,
    p.agentId ?? null,
    p.agentName ?? null
  );
  // Push real-time pro broker, exceto se silent (delegar_tarefa já emite
  // notify do work_item — segundo notify do chat seria poke duplicado).
  if (!p.silent) {
    const isManagerAction = (p.role === "gerente") && (p.type === "decisao" || p.type === "pedir");
    notify({
      kind: "chat",
      type: p.type,
      to: p.to ?? null,
      from_agent_id: p.agentId ?? null,
      from_role: p.role,
      urgent: p.type === "alerta" || p.type === "passar" || isManagerAction,
      message_id: id,
    });
  }

  return {
    id,
    created_at: ts,
    session_id: p.sessionId,
    session_name: p.sessionName,
    role: p.role,
    type: p.type,
    to_target: p.to ?? null,
    task_id: p.taskId ?? null,
    files: p.files && p.files.length ? JSON.stringify(p.files) : null,
    message: p.message,
    agent_id: p.agentId ?? null,
    agent_name: p.agentName ?? null,
  };
}

export function listChat(
  db: Database.Database,
  opts: { limit?: number; since?: number; to?: string | null; type?: ChatType } = {}
): ChatRow[] {
  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.since) {
    clauses.push("created_at > ?");
    params.push(opts.since);
  }
  if (opts.to) {
    clauses.push("to_target = ?");
    params.push(opts.to);
  }
  if (opts.type) {
    clauses.push("type = ?");
    params.push(opts.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 30;
  return db
    .prepare(`SELECT * FROM chat_messages ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as ChatRow[];
}

export function formatChatLine(row: ChatRow): string {
  const time = new Date(row.created_at).toISOString().replace("T", " ").slice(0, 19);
  const tag = row.type === "falar" ? "" : ` [${row.type}]`;
  const dest = row.to_target ? ` -> ${row.to_target}` : "";
  const who = row.agent_name
    ? `${row.agent_name}/${row.role}`
    : row.session_name;
  return `[${time}] ${who}${tag}${dest}: ${row.message}`;
}
