import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const HOME = homedir();
export const AGENTDESK_DIR = join(HOME, ".agentdesk");
// Tests, brokers and isolated teams can point every AgentDesk process at the
// same explicit database.  Keep ~/.agentdesk as the zero-config fallback.
const ENV_DB_PATH = process.env.AGENTDESK_DB?.trim();
export const DB_PATH = ENV_DB_PATH || join(AGENTDESK_DIR, "agentdesk.db");

/**
 * Stable scope used to isolate managers, workers, messages and work items.
 * Folder wins because it is the closest thing AgentDesk currently has to a
 * workspace id. Project is only a fallback for clients that do not send cwd.
 */
export function deriveTeamKey(folder?: string | null, project?: string | null): string {
  const rawFolder = folder?.trim();
  if (rawFolder) {
    const path = normalize(rawFolder).replace(/\/+$/, "") || "/";
    return `folder:${path}`;
  }
  const rawProject = project?.trim();
  if (rawProject) return `project:${rawProject.toLowerCase()}`;
  return "default";
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbDir = dirname(DB_PATH);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  // Multiple MCP processes share this file. Wait briefly for the current
  // writer instead of surfacing SQLITE_BUSY during simultaneous opens/claims.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  migrate(db);

  _db = db;
  return db;
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

// Idempotente sob race: ALTER TABLE não tem "IF NOT EXISTS" em SQLite, então
// múltiplos processos abrindo o DB ao mesmo tempo (típico em multi-Claude)
// faz o segundo morrer com "duplicate column name". Esse helper é seguro.
function addColumnIfMissing(db: Database.Database, table: string, col: string, ddl: string): boolean {
  if (hasColumn(db, table, col)) return false;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    return true;
  } catch (e: any) {
    if (!/duplicate column/i.test(e?.message ?? "")) throw e;
    return false;
  }
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      task TEXT,
      project TEXT,
      folder TEXT,
      areas TEXT,
      intended_files TEXT,
      opened_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      closed_at INTEGER,
      team_key TEXT NOT NULL DEFAULT 'default'
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);

    CREATE TABLE IF NOT EXISTS roles (
      name TEXT PRIMARY KEY,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'strong',
      area TEXT,
      created_at INTEGER NOT NULL,
      released_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_locks_file ON locks(file_path);
    CREATE INDEX IF NOT EXISTS idx_locks_session ON locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_locks_active ON locks(released_at);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      to_target TEXT,
      task_id TEXT,
      files TEXT,
      message TEXT NOT NULL,
      team_key TEXT NOT NULL DEFAULT 'default'
    );

    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_target ON chat_messages(to_target);

    CREATE TABLE IF NOT EXISTS updates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      progress TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_updates_session ON updates(session_id);

    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      from_session TEXT NOT NULL,
      to_target TEXT NOT NULL,
      task_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0,
      accepted_at INTEGER,
      team_key TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      project TEXT,
      folder TEXT,
      personality_summary TEXT,
      preferred_work_style TEXT,
      current_task_id TEXT,
      current_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL DEFAULT 0,
      authority TEXT NOT NULL DEFAULT 'worker',
      team_key TEXT NOT NULL DEFAULT 'default',
      role_assigned_by TEXT,
      role_assigned_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_role_folder ON agents(role, folder);

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      acceptance TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'queued',
      project TEXT,
      folder TEXT,
      areas TEXT,
      intended_files TEXT,
      dependencies TEXT,
      assigned_to TEXT,
      assigned_role TEXT,
      owner_agent_id TEXT,
      owner_agent_name TEXT,
      owner_session_id TEXT,
      created_by_session TEXT,
      created_by_agent TEXT,
      blocked_reason TEXT,
      delivery_summary TEXT,
      validation_summary TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      delivered_at INTEGER,
      reviewed_at INTEGER,
      team_key TEXT NOT NULL DEFAULT 'default'
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
    CREATE INDEX IF NOT EXISTS idx_work_items_assigned ON work_items(assigned_to, assigned_role);
    CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_agent_id);
  `);

  // v2-v4: migrations idempotentes sob race (multi-process). Cada chamada é
  // segura — ALTER falha duplicate é silenciado.
  addColumnIfMissing(db, "sessions", "agent_id", "TEXT");
  addColumnIfMissing(db, "sessions", "agent_name", "TEXT");
  addColumnIfMissing(db, "sessions", "closed_at", "INTEGER");
  addColumnIfMissing(db, "chat_messages", "agent_id", "TEXT");
  addColumnIfMissing(db, "chat_messages", "agent_name", "TEXT");
  addColumnIfMissing(db, "locks", "agent_id", "TEXT");
  addColumnIfMissing(db, "locks", "agent_name", "TEXT");
  addColumnIfMissing(db, "agents", "last_seen_ms", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "agents", "tmux_pane", "TEXT");
  addColumnIfMissing(db, "agents", "auto_mode", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "agents", "tick_cursor_ms", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "agents", "progress_summary", "TEXT");

  // v5: authority is a capability; role is now only a manager-assigned label.
  // team_key scopes the unique manager and prevents cross-project routing.
  addColumnIfMissing(db, "agents", "authority", "TEXT NOT NULL DEFAULT 'worker'");
  addColumnIfMissing(db, "agents", "team_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "agents", "role_assigned_by", "TEXT");
  addColumnIfMissing(db, "agents", "role_assigned_at", "INTEGER");
  addColumnIfMissing(db, "sessions", "team_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "work_items", "team_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "chat_messages", "team_key", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "handoffs", "team_key", "TEXT NOT NULL DEFAULT 'default'");

  // v6: fechamento do ciclo. Onde o trabalho do item foi parar depois de
  // aprovado (branch empurrada e, quando dá, o PR aberto).
  addColumnIfMissing(db, "work_items", "integration_url", "TEXT");
  addColumnIfMissing(db, "work_items", "integrated_at", "INTEGER");

  migrateAuthorityAndTeams(db);
}

function migrateAuthorityAndTeams(db: Database.Database) {
  const migrationId = "v5-authority-team-scope";
  const tx = db.transaction(() => {
    const alreadyApplied = db
      .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(migrationId);

    if (!alreadyApplied) {
      const updateAgentTeam = db.prepare("UPDATE agents SET team_key = ? WHERE id = ?");
      const agents = db
        .prepare("SELECT id, folder, project FROM agents")
        .all() as Array<{ id: string; folder: string | null; project: string | null }>;
      for (const agent of agents) {
        updateAgentTeam.run(deriveTeamKey(agent.folder, agent.project), agent.id);
      }

      const updateSessionTeam = db.prepare("UPDATE sessions SET team_key = ? WHERE id = ?");
      const sessions = db
        .prepare("SELECT id, folder, project FROM sessions")
        .all() as Array<{ id: string; folder: string | null; project: string | null }>;
      for (const session of sessions) {
        updateSessionTeam.run(deriveTeamKey(session.folder, session.project), session.id);
      }

      const updateWorkTeam = db.prepare("UPDATE work_items SET team_key = ? WHERE id = ?");
      const workItems = db
        .prepare("SELECT id, folder, project FROM work_items")
        .all() as Array<{ id: string; folder: string | null; project: string | null }>;
      for (const item of workItems) {
        updateWorkTeam.run(deriveTeamKey(item.folder, item.project), item.id);
      }

      // Rows without their own folder inherit the team of the session that
      // created them. This keeps old databases isolated after the migration.
      db.prepare(
        `UPDATE work_items
         SET team_key = COALESCE(
           (SELECT s.team_key FROM sessions s WHERE s.id = work_items.created_by_session),
           team_key
         )
         WHERE team_key = 'default'`
      ).run();
      db.prepare(
        `UPDATE chat_messages
         SET team_key = COALESCE(
           (SELECT s.team_key FROM sessions s WHERE s.id = chat_messages.session_id),
           'default'
         )`
      ).run();
      db.prepare(
        `UPDATE handoffs
         SET team_key = COALESCE(
           (SELECT s.team_key FROM sessions s WHERE s.id = handoffs.from_session),
           'default'
         )`
      ).run();

      // Legacy compatibility: only this one-time migration translates the old
      // role into authority. Afterwards assigning the free-form role
      // "gerente" never grants privileges.
      db.prepare(
        "UPDATE agents SET authority = 'manager' WHERE lower(trim(role)) = 'gerente'"
      ).run();

      // Old installations may already contain several gerente identities for
      // one folder. Keep the live/most-recent one and safely demote the rest.
      const managers = db
        .prepare(
          `SELECT id, team_key FROM agents
           WHERE authority = 'manager' AND status != 'archived'
           ORDER BY team_key ASC,
             CASE status
               WHEN 'working' THEN 0
               WHEN 'available' THEN 1
               WHEN 'paused' THEN 2
               WHEN 'dead' THEN 3
               ELSE 4
             END ASC,
             updated_at DESC,
             created_at ASC`
        )
        .all() as Array<{ id: string; team_key: string }>;
      const claimedTeams = new Set<string>();
      const demote = db.prepare(
        "UPDATE agents SET authority = 'worker', updated_at = ? WHERE id = ?"
      );
      for (const manager of managers) {
        if (claimedTeams.has(manager.team_key)) demote.run(Date.now(), manager.id);
        else claimedTeams.add(manager.team_key);
      }

      db.prepare(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
      ).run(migrationId, Date.now());
    }

    // The partial index is the cross-process race guard for concurrent /abrir.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_manager_per_team
       ON agents(team_key)
       WHERE authority = 'manager' AND status != 'archived'`
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team_key)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_agents_team_capacity ON agents(team_key, authority, status, updated_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_agents_team_pane ON agents(team_key, tmux_pane)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team_key)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_team_status ON sessions(team_key, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_team ON work_items(team_key)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_team_queue ON work_items(team_key, status, assigned_to, assigned_role, created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chat_team_created ON chat_messages(team_key, created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_team_pending ON handoffs(team_key, accepted, created_at)");
  });
  tx.immediate();
}

export function now(): number {
  return Date.now();
}
