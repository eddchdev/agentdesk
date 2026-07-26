import type Database from "better-sqlite3";
import { newId } from "./ids.js";
import { deriveTeamKey, now } from "./db.js";

export { deriveTeamKey } from "./db.js";

export type AgentStatus = "available" | "working" | "paused" | "dead" | "archived";
export type AgentAuthority = "manager" | "worker";

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  authority: AgentAuthority;
  team_key: string;
  project: string | null;
  folder: string | null;
  personality_summary: string | null;
  preferred_work_style: string | null;
  current_task_id: string | null;
  current_session_id: string | null;
  status: AgentStatus;
  created_at: number;
  updated_at: number;
  last_heartbeat: number;
  last_seen_ms: number;
  tmux_pane: string | null;
  auto_mode: number;
  progress_summary: string | null;
  tick_cursor_ms: number;
  role_assigned_by: string | null;
  role_assigned_at: number | null;
}

// Pool de nomes humanos para agentes. "Eduardo" foi removido — é o nome do dono
// (Eduardo Chamorra), reusar causa colisão de identidade no chat.
const NAME_POOL = [
  "Jonathan", "Marta", "Bruno", "Lara", "Davi", "Nina", "Caio", "Sofia",
  "Aline", "Tiago", "Beatriz", "Renato", "Camila", "Henrique", "Larissa",
  "Felipe", "Isabela", "Mateus", "Júlia", "Rafael", "Bianca", "Diego",
  "Carla", "Vinícius", "Patrícia", "Lucas", "Mariana", "Fernanda",
  "Gabriel", "Helena", "Igor", "Joana", "Kaique", "Letícia", "Murilo",
  "Natália", "Otávio", "Paula", "Quésia", "Ricardo", "Sabrina", "Thiago",
  "Úrsula", "Vitória", "Wesley", "Yasmin", "Zilda", "André", "Clarissa",
  "Débora", "Enzo", "Flávia", "Gustavo",
];

// Pega nome único do pool, com proteção contra race: dois processos lendo
// snapshot simultâneo podiam escolher o mesmo nome livre, e o segundo falha
// no createAgent com UNIQUE constraint. Aqui retorna candidato, mas o
// caller deve estar preparado pra retry se o INSERT colidir.
export function pickUniqueName(db: Database.Database): string {
  const taken = new Set(
    (db.prepare("SELECT name FROM agents").all() as { name: string }[]).map((r) => r.name)
  );
  const free = NAME_POOL.filter((n) => !taken.has(n));
  if (free.length) {
    return free[Math.floor(Math.random() * free.length)];
  }
  // Pool exausta: sufixo + componente aleatório evita colisão em race.
  const base = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${base}-${suffix}`;
}

export function findMatchingAgents(
  db: Database.Database,
  role: string,
  folder?: string | null,
  opts?: { anyFolder?: boolean; teamKey?: string }
): AgentRow[] {
  const params: any[] = [role];
  let where = "role = ? AND status != 'archived'";
  if (opts?.teamKey) {
    where += " AND team_key = ?";
    params.push(opts.teamKey);
  }
  if (!opts?.anyFolder) {
    if (folder) {
      where += " AND folder = ?";
      params.push(folder);
    } else {
      where += " AND (folder IS NULL OR folder = '')";
    }
  }
  return db
    .prepare(`SELECT * FROM agents WHERE ${where} ORDER BY updated_at DESC`)
    .all(...params) as AgentRow[];
}

export function findAgentByName(db: Database.Database, name: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow) ?? null;
}

export function findAgentById(db: Database.Database, id: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow) ?? null;
}

export function getAgentByIdentifier(db: Database.Database, idOrName: string): AgentRow | null {
  return findAgentById(db, idOrName) ?? findAgentByName(db, idOrName);
}

export function isManagerAgent(agent: AgentRow | null | undefined): boolean {
  return agent?.authority === "manager";
}

export function findManagerForTeam(db: Database.Database, teamKey: string): AgentRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM agents
         WHERE team_key = ? AND authority = 'manager' AND status != 'archived'
         ORDER BY
           CASE status WHEN 'working' THEN 0 WHEN 'available' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
           updated_at DESC
         LIMIT 1`
      )
      .get(teamKey) as AgentRow | undefined) ?? null
  );
}

export function listAgentsForTeam(
  db: Database.Database,
  teamKey: string,
  opts: { include_archived?: boolean } = {}
): AgentRow[] {
  const archived = opts.include_archived ? "" : "AND status != 'archived'";
  return db
    .prepare(
      `SELECT * FROM agents WHERE team_key = ? ${archived}
       ORDER BY authority = 'manager' DESC, created_at ASC`
    )
    .all(teamKey) as AgentRow[];
}

export function createAgent(
  db: Database.Database,
  args: {
    name: string;
    role: string;
    authority?: AgentAuthority;
    team_key?: string;
    project?: string | null;
    folder?: string | null;
    personality_summary?: string | null;
    preferred_work_style?: string | null;
    tmux_pane?: string | null;
    role_assigned_by?: string | null;
    role_assigned_at?: number | null;
  }
): AgentRow {
  const stmt = db.prepare(
    `INSERT INTO agents
     (id, name, role, authority, team_key, project, folder, personality_summary, preferred_work_style,
      current_task_id, current_session_id, status, created_at, updated_at, last_heartbeat,
      last_seen_ms, tmux_pane, auto_mode, role_assigned_by, role_assigned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'available', ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  // last_seen_ms inicia 1ms antes do created_at pra evitar perder mensagens
  // chegadas no mesmo ms da criação. O filtro do tick é created_at > since,
  // então se ambos = ts, a mensagem some.

  // Race-safe: se outro processo criou agente com o mesmo nome entre o
  // pickUniqueName() e o INSERT, retry com um sufixo aleatório. Até 5
  // tentativas — depois disso o problema é estrutural.
  let name = args.name;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    const ts = now();
    try {
      stmt.run(
        id,
        name,
        args.role,
        args.authority ?? "worker",
        args.team_key ?? deriveTeamKey(args.folder, args.project),
        args.project ?? null,
        args.folder ?? null,
        args.personality_summary ?? null,
        args.preferred_work_style ?? null,
        ts,
        ts,
        ts,
        ts - 1, // last_seen_ms < created_at evita perder msgs ms-iguais
        args.tmux_pane ?? null,
        args.role_assigned_by ?? null,
        args.role_assigned_at ?? null
      );
      return findAgentById(db, id)!;
    } catch (e: any) {
      if (!/UNIQUE.*agents\.name/i.test(e?.message ?? "")) throw e;
      // Colisão: usa nome + sufixo curto.
      name = `${args.name}-${Math.random().toString(36).slice(2, 5)}`;
    }
  }
  throw new Error(`Não consegui escolher nome único para agente em 5 tentativas.`);
}

/**
 * Race-safe manager bootstrap. The partial unique index in db.ts is the final
 * guard, while BEGIN IMMEDIATE keeps the common path deterministic across MCP
 * processes opening at the same time.
 */
export function createOrGetManager(
  db: Database.Database,
  args: {
    name: string;
    role?: string;
    team_key?: string;
    project?: string | null;
    folder?: string | null;
    personality_summary?: string | null;
    preferred_work_style?: string | null;
    tmux_pane?: string | null;
  }
): { agent: AgentRow; created: boolean } {
  const teamKey = args.team_key ?? deriveTeamKey(args.folder, args.project);
  const tx = db.transaction(() => {
    const existing = findManagerForTeam(db, teamKey);
    if (existing) return { agent: existing, created: false };

    try {
      const agent = createAgent(db, {
        ...args,
        role: args.role?.trim() || "gerente",
        authority: "manager",
        team_key: teamKey,
      });
      return { agent, created: true };
    } catch (e: any) {
      // A DB index also protects callers that did not share this transaction.
      if (/UNIQUE.*agents\.team_key/i.test(e?.message ?? "")) {
        const winner = findManagerForTeam(db, teamKey);
        if (winner) return { agent: winner, created: false };
      }
      throw e;
    }
  });
  return tx.immediate() as { agent: AgentRow; created: boolean };
}

/**
 * Manager-only, same-team role assignment. Role is deliberately free-form and
 * never changes authority, even when its text is "gerente".
 */
export function assignAgentRole(
  db: Database.Database,
  input: { managerAgentId: string; target: string; role: string }
): AgentRow {
  const manager = findAgentById(db, input.managerAgentId);
  if (!manager || !isManagerAgent(manager)) {
    throw new Error("Apenas o gerente da equipe pode atribuir papéis.");
  }

  const target = getAgentByIdentifier(db, input.target);
  if (!target || target.status === "archived") {
    throw new Error(`Agente '${input.target}' não encontrado ou arquivado.`);
  }
  if (target.team_key !== manager.team_key) {
    throw new Error(`Agente ${target.name} pertence a outra equipe (${target.team_key}).`);
  }

  const role = input.role.trim();
  if (!role) throw new Error("Papel não pode ser vazio.");
  if (role.length > 80) throw new Error("Papel deve ter no máximo 80 caracteres.");
  if (/\r|\n/.test(role)) throw new Error("Papel deve ocupar uma única linha.");

  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE agents
       SET role = ?, role_assigned_by = ?, role_assigned_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(role, manager.id, ts, ts, target.id);

    // The active session keeps a role snapshot for chat and lock rendering.
    // Historical sessions remain untouched.
    if (target.current_session_id) {
      db.prepare(
        `UPDATE sessions SET role = ?
         WHERE id = ? AND status IN ('active', 'suspect')`
      ).run(role, target.current_session_id);
    }
  });
  tx.immediate();
  return findAgentById(db, target.id)!;
}

export function requireManagerAgentForSession(
  db: Database.Database,
  sessionId: string
): AgentRow {
  const agent = getAgentForSession(db, sessionId);
  if (!agent || !isManagerAgent(agent)) {
    throw new Error("Apenas o gerente da equipe pode executar esta ação.");
  }
  return agent;
}

export function markAgentSeen(db: Database.Database, agentId: string, untilMs: number) {
  db.prepare("UPDATE agents SET last_seen_ms = ?, updated_at = ? WHERE id = ?").run(untilMs, now(), agentId);
}

export function setAgentAutoMode(db: Database.Database, agentId: string, on: boolean, tmuxPane?: string | null) {
  if (tmuxPane !== undefined) {
    db.prepare("UPDATE agents SET auto_mode = ?, tmux_pane = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, tmuxPane, now(), agentId);
  } else {
    db.prepare("UPDATE agents SET auto_mode = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, now(), agentId);
  }
}

export function setAgentStatus(
  db: Database.Database,
  agentId: string,
  status: AgentStatus,
  extra?: { current_session_id?: string | null; current_task_id?: string | null }
) {
  const ts = now();
  const fields: string[] = ["status = ?", "updated_at = ?"];
  const vals: any[] = [status, ts];
  if (extra && "current_session_id" in extra) {
    fields.push("current_session_id = ?");
    vals.push(extra.current_session_id ?? null);
  }
  if (extra && "current_task_id" in extra) {
    fields.push("current_task_id = ?");
    vals.push(extra.current_task_id ?? null);
  }
  vals.push(agentId);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
}

export function touchAgent(db: Database.Database, agentId: string) {
  const ts = now();
  // Propaga TMUX_PANE do env do processo MCP. O servidor MCP é spawnado como
  // filho do processo Claude Code, então TMUX_PANE é herdado quando o Claude
  // está rodando dentro de um pane tmux. Isso garante que o watcher consiga
  // acordar o agente sem ele ter chamado entrar_modo_auto explicitamente —
  // pré-requisito do "tempo real" sub-segundo.
  const pane = process.env.TMUX_PANE || null;
  if (pane) {
    db.prepare(
      "UPDATE agents SET updated_at = ?, last_heartbeat = ?, tmux_pane = ? WHERE id = ?"
    ).run(ts, ts, pane, agentId);
  } else {
    db.prepare("UPDATE agents SET updated_at = ?, last_heartbeat = ? WHERE id = ?").run(ts, ts, agentId);
  }
}

export function listAgents(
  db: Database.Database,
  opts: { include_archived?: boolean } = {}
): AgentRow[] {
  const where = opts.include_archived ? "" : "WHERE status != 'archived'";
  return db.prepare(`SELECT * FROM agents ${where} ORDER BY created_at ASC`).all() as AgentRow[];
}

export function getAgentForSession(db: Database.Database, sessionId: string): AgentRow | null {
  const s = db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId) as
    | { agent_id: string | null }
    | undefined;
  if (!s?.agent_id) return null;
  return findAgentById(db, s.agent_id);
}
