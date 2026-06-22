import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DB_PATH = join(homedir(), ".agentdesk", "agentdesk.db");

// Espelha src/lifecycle.ts — ver comentário lá sobre OCIOSO=300s.
const SUSPECT_AFTER_MS = 90_000;
const DEAD_AFTER_MS = 360_000;

let db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Banco AgentDesk não encontrado em ${DB_PATH}. Rode o MCP pelo menos uma vez (npm run dev) para criar.`
    );
  }
  // Write mode: precisamos inserir mensagens do usuário.
  db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

const OWNER_SESSION_ID = "desktop-owner";
const OWNER_SESSION_NAME = "Eduardo";
const OWNER_ROLE = "dono";

export function sendUserMessage(to: string | null, message: string, type: "alerta" | "pedir" | "decisao" = "alerta"): void {
  const d = openDb();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const ts = Date.now();
  d.prepare(
    `INSERT INTO chat_messages
     (id, created_at, session_id, session_name, role, type, to_target, task_id, files, message, agent_id, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`
  ).run(id, ts, OWNER_SESSION_ID, OWNER_SESSION_NAME, OWNER_ROLE, type, to, message);
}

export interface SessionView {
  id: string;
  name: string;
  agent_name: string | null;
  role: string;
  task: string | null;
  project: string | null;
  folder: string | null;
  areas: string[];
  intended_files: string[];
  opened_at: number;
  last_heartbeat: number;
  status: "active" | "suspect" | "dead" | "closed";
}

export interface ChatMessageView {
  id: string;
  created_at: number;
  session_id: string;
  session_name: string;
  role: string;
  type: string;
  to_target: string | null;
  task_id: string | null;
  files: string[];
  message: string;
}

export interface LockView {
  id: string;
  session_id: string;
  session_name: string;
  role: string;
  file_path: string;
  kind: string;
  area: string | null;
  created_at: number;
  task_id: string | null;
  task_title: string | null;
}

export interface HandoffView {
  id: string;
  from_session: string;
  from_name: string | null;
  to_target: string;
  task_id: string | null;
  task_title: string | null;
  note: string | null;
  created_at: number;
  accepted: boolean;
  accepted_at: number | null;
}

export interface DelegationView {
  id: string;
  from_name: string;
  from_role: string;
  to_target: string;
  message: string;
  created_at: number;
  seen: boolean;
}

export interface WorkItemView {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  assigned_role: string | null;
  owner_agent_name: string | null;
  blocked_reason: string | null;
  delivery_summary: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  updated_at: number;
}

export interface ActivityView {
  session_id: string;
  agent_name: string;
  role: string;
  description: string;
  updated_at: number;
  status: SessionView["status"];
}

export interface Snapshot {
  now: number;
  sessions: SessionView[];
  chat: ChatMessageView[];
  locks: LockView[];
  handoffs: HandoffView[];
  delegations: DelegationView[];
  workItems: WorkItemView[];
  activities: ActivityView[];
  counts: { active: number; suspect: number; dead: number; closed: number };
}

function deriveStatus(
  last_heartbeat: number,
  status: string,
  closed_at: number | null,
  now: number
): SessionView["status"] {
  if (status === "closed" || closed_at) return "closed";
  const age = now - last_heartbeat;
  if (age >= DEAD_AFTER_MS) return "dead";
  if (age >= SUSPECT_AFTER_MS) return "suspect";
  return "active";
}

function parseList(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function snapshot(): Snapshot {
  const d = openDb();
  const now = Date.now();

  const sessionRows = d
    .prepare(
      `WITH ranked AS (
         SELECT id, name, agent_name, role, task, project, folder, areas, intended_files,
                opened_at, last_heartbeat, status, closed_at,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(agent_name, id)
                  ORDER BY last_heartbeat DESC
                ) AS rn
         FROM sessions
         WHERE status != 'closed'
       )
       SELECT id, name, agent_name, role, task, project, folder, areas, intended_files,
              opened_at, last_heartbeat, status, closed_at
       FROM ranked
       WHERE rn = 1
       ORDER BY last_heartbeat DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    agent_name: string | null;
    role: string;
    task: string | null;
    project: string | null;
    folder: string | null;
    areas: string | null;
    intended_files: string | null;
    opened_at: number;
    last_heartbeat: number;
    status: string;
    closed_at: number | null;
  }>;

  const sessions: SessionView[] = sessionRows.map((r) => ({
    id: r.id,
    name: r.name,
    agent_name: r.agent_name,
    role: r.role,
    task: r.task,
    project: r.project,
    folder: r.folder,
    areas: parseList(r.areas),
    intended_files: parseList(r.intended_files),
    opened_at: r.opened_at,
    last_heartbeat: r.last_heartbeat,
    status: deriveStatus(r.last_heartbeat, r.status, r.closed_at, now),
  }));

  const counts = { active: 0, suspect: 0, dead: 0, closed: 0 };
  for (const s of sessions) counts[s.status]++;

  const chatRows = d
    .prepare(
      "SELECT id, created_at, session_id, session_name, role, type, to_target, task_id, files, message FROM chat_messages ORDER BY created_at DESC LIMIT 200"
    )
    .all() as Array<{
    id: string;
    created_at: number;
    session_id: string;
    session_name: string;
    role: string;
    type: string;
    to_target: string | null;
    task_id: string | null;
    files: string | null;
    message: string;
  }>;

  const chat: ChatMessageView[] = chatRows
    .map((r) => ({
      id: r.id,
      created_at: r.created_at,
      session_id: r.session_id,
      session_name: r.session_name,
      role: r.role,
      type: r.type,
      to_target: r.to_target,
      task_id: r.task_id,
      files: parseList(r.files),
      message: r.message,
    }))
    .reverse();

  const lockRows = d
    .prepare(
      `SELECT l.id, l.session_id, s.name AS session_name, s.role, l.file_path, l.kind, l.area, l.created_at,
              t.id AS task_id, t.title AS task_title
         FROM locks l
         JOIN sessions s ON s.id = l.session_id
         LEFT JOIN tasks t ON t.session_id = l.session_id AND t.status = 'in_progress'
        WHERE l.released_at IS NULL
        GROUP BY l.id
        ORDER BY l.created_at DESC`
    )
    .all() as Array<{
    id: string;
    session_id: string;
    session_name: string;
    role: string;
    file_path: string;
    kind: string;
    area: string | null;
    created_at: number;
    task_id: string | null;
    task_title: string | null;
  }>;

  const locks: LockView[] = lockRows;

  const handoffRows = d
    .prepare(
      `SELECT h.id, h.from_session, s.name AS from_name, h.to_target, h.task_id, t.title AS task_title,
              h.note, h.created_at, h.accepted, h.accepted_at
         FROM handoffs h
         LEFT JOIN sessions s ON s.id = h.from_session
         LEFT JOIN tasks t ON t.id = h.task_id
        ORDER BY h.created_at DESC
        LIMIT 20`
    )
    .all() as Array<{
    id: string;
    from_session: string;
    from_name: string | null;
    to_target: string;
    task_id: string | null;
    task_title: string | null;
    note: string | null;
    created_at: number;
    accepted: number;
    accepted_at: number | null;
  }>;

  const handoffs: HandoffView[] = handoffRows.map((r) => ({
    ...r,
    accepted: r.accepted === 1,
  }));

  // Delegações: mensagens de chat tipo "decisao" do gerente com to_target, últimas 24h
  const delegationCutoff = now - 24 * 60 * 60 * 1000;
  const delegationRows = d
    .prepare(
      `SELECT cm.id, cm.created_at, cm.to_target, cm.message,
              COALESCE(cm.agent_name, cm.session_name) AS from_name,
              cm.role AS from_role
         FROM chat_messages cm
        WHERE cm.type = 'decisao'
          AND cm.role = 'gerente'
          AND cm.to_target IS NOT NULL
          AND cm.created_at > ?
        ORDER BY cm.created_at DESC
        LIMIT 20`
    )
    .all(delegationCutoff) as Array<{
    id: string; created_at: number; to_target: string; message: string;
    from_name: string; from_role: string;
  }>;

  // Para cada delegação, checar se o destinatário já viu (last_seen_ms > created_at)
  const seenCheck = d.prepare(
    `SELECT MAX(last_seen_ms) AS m FROM agents
      WHERE (name = ? OR role = ?) AND status NOT IN ('archived','dead')`
  );

  const delegations: DelegationView[] = delegationRows.map((r) => {
    const ls = (seenCheck.get(r.to_target, r.to_target) as { m: number | null } | undefined)?.m ?? 0;
    return {
      id: r.id,
      from_name: r.from_name,
      from_role: r.from_role,
      to_target: r.to_target,
      message: r.message,
      created_at: r.created_at,
      seen: ls > r.created_at,
    };
  });

  const hasWorkItems = d
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='work_items'")
    .get() as { c: number };
  const workItems: WorkItemView[] = hasWorkItems.c > 0
    ? (d
        .prepare(
          `SELECT id, title, status, priority, assigned_to, assigned_role, owner_agent_name,
                  blocked_reason, delivery_summary, worktree_path, branch_name, updated_at
             FROM work_items
            WHERE status NOT IN ('done','canceled')
            ORDER BY updated_at DESC
            LIMIT 30`
        )
        .all() as WorkItemView[])
    : [];

  // Activities: o que cada agente em sessão ativa está fazendo, em linguagem natural.
  // Prioridade: activity_description (se setada) → progress_summary simplificado → task title.
  const hasActivityCol = d
    .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('agents') WHERE name='activity_description'")
    .get() as { c: number };

  const activityRows = d
    .prepare(
      hasActivityCol.c > 0
        ? `SELECT a.name AS agent_name, a.role, a.progress_summary, a.activity_description,
                  s.id AS session_id, s.task, s.last_heartbeat, s.status, s.closed_at
             FROM agents a
             INNER JOIN sessions s ON s.id = a.current_session_id
            WHERE a.status NOT IN ('archived','dead','paused')
              AND s.status != 'closed'
            ORDER BY s.last_heartbeat DESC
            LIMIT 12`
        : `SELECT a.name AS agent_name, a.role, a.progress_summary, NULL AS activity_description,
                  s.id AS session_id, s.task, s.last_heartbeat, s.status, s.closed_at
             FROM agents a
             INNER JOIN sessions s ON s.id = a.current_session_id
            WHERE a.status NOT IN ('archived','dead','paused')
              AND s.status != 'closed'
            ORDER BY s.last_heartbeat DESC
            LIMIT 12`
    )
    .all() as Array<{
    agent_name: string;
    role: string;
    progress_summary: string | null;
    activity_description: string | null;
    session_id: string;
    task: string | null;
    last_heartbeat: number;
    status: string;
    closed_at: number | null;
  }>;

  const activities: ActivityView[] = activityRows
    .map((r) => ({
      session_id: r.session_id,
      agent_name: r.agent_name,
      role: r.role,
      description: simplifyActivity(r.activity_description, r.progress_summary, r.task),
      updated_at: r.last_heartbeat,
      status: deriveStatus(r.last_heartbeat, r.status, r.closed_at, now),
    }))
    .filter((a) => a.status !== "dead" && a.status !== "closed");

  return { now, sessions, chat, locks, handoffs, delegations, workItems, activities, counts };
}

/**
 * Converte progresso técnico do agente em descrição curta e natural.
 * Remove timestamps, parenteses (refs file:line, contagens), reduz a primeira frase.
 */
function simplifyActivity(activity: string | null, progress: string | null, task: string | null): string {
  if (activity && activity.trim()) return activity.trim();

  const src = progress || task || "Sem descrição.";
  let s = src
    .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "")  // strip [timestamp] prefix
    .replace(/\s*\([^)]*\)/g, "")                    // strip (parentheses content)
    .replace(/\s*file:line/gi, "")                   // strip "file:line" mentions
    .replace(/\s+/g, " ")
    .trim();

  // Primeira frase (até primeiro ponto final seguido de espaço/fim)
  const sentenceEnd = s.search(/\.(\s|$)/);
  if (sentenceEnd > 30) s = s.slice(0, sentenceEnd);
  if (s.length > 140) s = s.slice(0, 137) + "…";
  return s || "Sem descrição.";
}
