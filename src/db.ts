import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const HOME = homedir();
export const AGENTDESK_DIR = join(HOME, ".agentdesk");
export const DB_PATH = join(AGENTDESK_DIR, "agentdesk.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(AGENTDESK_DIR)) {
    mkdirSync(AGENTDESK_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  seedRoles(db);

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
function addColumnIfMissing(db: Database.Database, table: string, col: string, ddl: string) {
  if (hasColumn(db, table, col)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  } catch (e: any) {
    if (!/duplicate column/i.test(e?.message ?? "")) throw e;
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
      closed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);

    CREATE TABLE IF NOT EXISTS roles (
      name TEXT PRIMARY KEY,
      description TEXT
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
      message TEXT NOT NULL
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
      accepted_at INTEGER
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
      last_heartbeat INTEGER NOT NULL DEFAULT 0
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
      reviewed_at INTEGER
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
}

const INITIAL_ROLES = [
  { name: "gerente", description: "Coordena a equipe, distribui tarefas, resolve conflitos e força liberações." },
  { name: "backend", description: "Implementa APIs, banco, lógica de servidor e integrações." },
  { name: "frontend", description: "Implementa UI, telas, componentes e fluxos do usuário." },
  { name: "bugs", description: "Caça e corrige bugs reportados, faz triagem de erros." },
  { name: "whatsapp", description: "Cuida de integrações WhatsApp/Baileys, sessões, envio e fluxo do bot." },
  { name: "qa", description: "Revisa entregas, testa cenários e valida critérios de aceite." },
];

function seedRoles(db: Database.Database) {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)"
  );
  const tx = db.transaction(() => {
    for (const r of INITIAL_ROLES) stmt.run(r.name, r.description);
  });
  tx();
}

export function now(): number {
  return Date.now();
}
