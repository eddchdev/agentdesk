import type Database from "better-sqlite3";
import { now } from "./db.js";
import { newId } from "./ids.js";
import { notify } from "./notifier.js";

export type WorkItemStatus = "queued" | "claimed" | "working" | "blocked" | "review" | "done" | "canceled";

export interface WorkItemRow {
  id: string;
  title: string;
  description: string | null;
  acceptance: string | null;
  priority: string;
  status: WorkItemStatus;
  project: string | null;
  folder: string | null;
  areas: string | null;
  intended_files: string | null;
  dependencies: string | null;
  assigned_to: string | null;
  assigned_role: string | null;
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  owner_session_id: string | null;
  created_by_session: string | null;
  created_by_agent: string | null;
  blocked_reason: string | null;
  delivery_summary: string | null;
  validation_summary: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  delivered_at: number | null;
  reviewed_at: number | null;
}

export function createWorkItem(
  db: Database.Database,
  input: {
    title: string;
    description?: string | null;
    acceptance?: string | null;
    priority?: string | null;
    project?: string | null;
    folder?: string | null;
    areas?: string[];
    intended_files?: string[];
    dependencies?: string[];
    assigned_to?: string | null;
    assigned_role?: string | null;
    created_by_session?: string | null;
    created_by_agent?: string | null;
  }
): WorkItemRow {
  const id = newId();
  const ts = now();
  db.prepare(
    `INSERT INTO work_items
     (id, title, description, acceptance, priority, status, project, folder, areas, intended_files,
      dependencies, assigned_to, assigned_role, created_by_session, created_by_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.description ?? null,
    input.acceptance ?? null,
    input.priority ?? "normal",
    input.project ?? null,
    input.folder ?? null,
    jsonList(input.areas),
    jsonList(input.intended_files),
    jsonList(input.dependencies),
    input.assigned_to ?? null,
    input.assigned_role ?? null,
    input.created_by_session ?? null,
    input.created_by_agent ?? null,
    ts,
    ts
  );
  // Notifica destinatário: alvo é nome do agente OU cargo.
  notify({
    kind: "work_item",
    type: "queued",
    to: input.assigned_to || input.assigned_role || null,
    priority: input.priority ?? "normal",
    urgent: input.priority === "critica" || input.priority === "alta",
    work_item_id: id,
  });
  return getWorkItem(db, id)!;
}

export function getWorkItem(db: Database.Database, id: string): WorkItemRow | null {
  return (db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined) ?? null;
}

export function listWorkItems(
  db: Database.Database,
  opts: { status?: string | null; assigned?: string | null; limit?: number } = {}
): WorkItemRow[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.assigned) {
    clauses.push("(assigned_to = ? OR assigned_role = ? OR owner_agent_name = ?)");
    params.push(opts.assigned, opts.assigned, opts.assigned);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM work_items ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, opts.limit ?? 30) as WorkItemRow[];
}

export function claimWorkItem(
  db: Database.Database,
  id: string,
  owner: { agent_id: string | null; agent_name: string | null; session_id: string }
): WorkItemRow {
  const ts = now();
  // Atômico: SQLite avalia o WHERE e o UPDATE numa única operação write-locked,
  // então dois agentes simultâneos não conseguem assumir o mesmo work item.
  // Aceita reclaim do mesmo dono (owner_agent_id casa), claim novo (owner NULL)
  // e mudança de dono apenas via reset (status='blocked' E owner NULL — gerente
  // tem que limpar primeiro). Usa RETURNING pra evitar SELECT extra.
  const row = db
    .prepare(
      `UPDATE work_items
       SET status = 'working',
           owner_agent_id = ?,
           owner_agent_name = ?,
           owner_session_id = ?,
           blocked_reason = NULL,
           claimed_at = COALESCE(claimed_at, ?),
           updated_at = ?
       WHERE id = ?
         AND (
           (status IN ('queued', 'claimed', 'blocked') AND (owner_agent_id IS NULL OR owner_agent_id = ?))
           OR (status = 'working' AND owner_agent_id = ?)
         )
       RETURNING *`
    )
    .get(
      owner.agent_id,
      owner.agent_name,
      owner.session_id,
      ts,
      ts,
      id,
      owner.agent_id,
      owner.agent_id
    ) as WorkItemRow | undefined;

  if (row) return row;

  // UPDATE não acertou: precisa explicar o motivo.
  const current = getWorkItem(db, id);
  if (!current) throw new Error(`Tarefa estruturada ${id} não encontrada.`);
  if (!["queued", "claimed", "blocked", "working"].includes(current.status)) {
    throw new Error(`Tarefa ${id} está em status ${current.status}; não pode ser assumida.`);
  }
  throw new Error(
    `Tarefa ${id} já pertence a ${current.owner_agent_name ?? current.owner_agent_id}.`
  );
}

export function updateWorkItemStatus(
  db: Database.Database,
  id: string,
  status: WorkItemStatus,
  fields: Partial<Pick<WorkItemRow, "blocked_reason" | "delivery_summary" | "validation_summary" | "worktree_path" | "branch_name">> = {}
): WorkItemRow {
  const item = getWorkItem(db, id);
  if (!item) throw new Error(`Tarefa estruturada ${id} não encontrada.`);
  const ts = now();
  const sets = ["status = ?", "updated_at = ?"];
  const vals: any[] = [status, ts];
  for (const key of ["blocked_reason", "delivery_summary", "validation_summary", "worktree_path", "branch_name"] as const) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      vals.push(fields[key] ?? null);
    }
  }
  if (status === "review") {
    sets.push("delivered_at = COALESCE(delivered_at, ?)");
    vals.push(ts);
  }
  if (status === "done") {
    sets.push("reviewed_at = COALESCE(reviewed_at, ?)");
    vals.push(ts);
  }
  vals.push(id);
  db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const result = getWorkItem(db, id)!;
  // Entrega pra review notifica qa/gerente. Outras transições silenciosas.
  if (status === "review") {
    notify({
      kind: "work_item",
      type: "delivered",
      to: "qa",
      priority: result.priority,
      urgent: true,
      work_item_id: id,
    });
  } else if (status === "blocked") {
    notify({
      kind: "work_item",
      type: "blocked",
      to: result.owner_agent_name || result.assigned_to || result.assigned_role || null,
      priority: result.priority,
      urgent: true,
      work_item_id: id,
    });
  }
  return result;
}

export function parseJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function jsonList(values?: string[] | null): string | null {
  return values?.length ? JSON.stringify(values) : null;
}
