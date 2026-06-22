import type Database from "better-sqlite3";
import { resolve, normalize } from "node:path";
import { newId } from "./ids.js";
import { now } from "./db.js";
import { deriveStatus, type SessionRow, sweepSessions } from "./lifecycle.js";

export interface LockRow {
  id: string;
  session_id: string;
  file_path: string;
  kind: string;
  area: string | null;
  created_at: number;
  released_at: number | null;
  agent_id: string | null;
  agent_name: string | null;
}

export interface LockResult {
  granted: { file: string; lock_id: string }[];
  conflicts: { file: string; held_file: string; held_by_session: string; held_by_name: string; held_by_role: string; status: string }[];
  warnings: { area: string; other_sessions: { name: string; role: string; files: string[] }[] }[];
}

export function acquireLocks(
  db: Database.Database,
  sessionId: string,
  files: string[],
  area?: string,
  agent?: { id: string; name: string } | null
): LockResult {
  sweepSessions(db);

  const result: LockResult = { granted: [], conflicts: [], warnings: [] };
  const ts = now();

  const insert = db.prepare(
    "INSERT INTO locks (id, session_id, file_path, kind, area, created_at, released_at, agent_id, agent_name) VALUES (?, ?, ?, 'strong', ?, ?, NULL, ?, ?)"
  );
  const releaseDead = db.prepare("UPDATE locks SET released_at = ? WHERE id = ?");

  const tx = db.transaction(() => {
    for (const fileRaw of files) {
      const file = normalizePath(fileRaw);
      const existing = db
        .prepare(
          `SELECT l.*, s.name as session_name, s.role as session_role, s.status as session_status, s.last_heartbeat as session_hb, s.closed_at as session_closed_at
           FROM locks l
           JOIN sessions s ON s.id = l.session_id
           WHERE l.released_at IS NULL`
        )
        .all() as Array<LockRow & {
          session_name: string;
          session_role: string;
          session_status: string;
          session_hb: number;
          session_closed_at: number | null;
        }>;

      let blocked = false;
      for (const ex of existing) {
        if (!locksOverlap(file, ex.file_path)) continue;
        if (ex.session_id === sessionId) {
          // already locked by self
          result.granted.push({ file, lock_id: ex.id });
          blocked = true;
          break;
        }
        const status = deriveStatus({
          last_heartbeat: ex.session_hb,
          status: ex.session_status as any,
          closed_at: ex.session_closed_at,
        });
        if (status === "active" || status === "suspect") {
          result.conflicts.push({
            file,
            held_file: ex.file_path,
            held_by_session: ex.session_id,
            held_by_name: ex.session_name,
            held_by_role: ex.session_role,
            status,
          });
          blocked = true;
          break;
        } else {
          // dead/closed lock — auto release
          releaseDead.run(ts, ex.id);
        }
      }

      if (blocked) continue;

      const id = newId();
      insert.run(id, sessionId, file, area ?? null, ts, agent?.id ?? null, agent?.name ?? null);
      result.granted.push({ file, lock_id: id });
    }

    if (area) {
      const others = db
        .prepare(
          `SELECT DISTINCT s.id as session_id, s.name, s.role
           FROM locks l
           JOIN sessions s ON s.id = l.session_id
           WHERE l.area = ? AND l.released_at IS NULL AND s.id != ?`
        )
        .all(area, sessionId) as { session_id: string; name: string; role: string }[];

      if (others.length) {
        const warningEntries = others.map((o) => {
          const files = db
            .prepare(
              "SELECT file_path FROM locks WHERE session_id = ? AND area = ? AND released_at IS NULL"
            )
            .all(o.session_id, area) as { file_path: string }[];
          return {
            name: o.name,
            role: o.role,
            files: files.map((f) => f.file_path),
          };
        });
        result.warnings.push({ area, other_sessions: warningEntries });
      }
    }
  });
  // IMMEDIATE força BEGIN IMMEDIATE: pega RESERVED lock no SQLite logo no início,
  // serializa todos os SELECT+INSERT contra outros writers. Sem isso, dois
  // processos chegam no SELECT da deferred transaction antes de qualquer um
  // tentar escrever, ambos passam pela verificação e ambos inserem o lock.
  tx.immediate();

  return result;
}

export function releaseLocks(
  db: Database.Database,
  sessionId: string,
  files?: string[],
  force?: boolean,
  callerRole?: string
): { released: string[] } {
  const ts = now();
  let stmt;
  let rows: { id: string; file_path: string }[];

  if (force && callerRole === "gerente") {
    if (files && files.length) {
      const placeholders = files.map(() => "?").join(",");
      rows = db
        .prepare(
          `SELECT id, file_path FROM locks WHERE released_at IS NULL AND file_path IN (${placeholders})`
        )
        .all(...files.map(normalizePath)) as { id: string; file_path: string }[];
    } else {
      rows = db
        .prepare("SELECT id, file_path FROM locks WHERE released_at IS NULL")
        .all() as { id: string; file_path: string }[];
    }
  } else if (files && files.length) {
    const placeholders = files.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT id, file_path FROM locks WHERE released_at IS NULL AND session_id = ? AND file_path IN (${placeholders})`
      )
      .all(sessionId, ...files.map(normalizePath)) as { id: string; file_path: string }[];
  } else {
    rows = db
      .prepare("SELECT id, file_path FROM locks WHERE released_at IS NULL AND session_id = ?")
      .all(sessionId) as { id: string; file_path: string }[];
  }

  stmt = db.prepare("UPDATE locks SET released_at = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(ts, r.id);
  });
  tx.immediate();

  return { released: rows.map((r) => r.file_path) };
}

export function activeLocks(db: Database.Database, limit = 100): Array<LockRow & { session_name: string; session_role: string }> {
  return db
    .prepare(
      `SELECT l.*, s.name as session_name, s.role as session_role
       FROM locks l
       JOIN sessions s ON s.id = l.session_id
       WHERE l.released_at IS NULL
       ORDER BY l.created_at DESC
       LIMIT ?`
    )
    .all(limit) as any;
}

export function detectConflicts(db: Database.Database, sessionId: string, files: string[]): {
  file: string;
  held_file: string;
  held_by_name: string;
  held_by_role: string;
  status: string;
}[] {
  const result: { file: string; held_file: string; held_by_name: string; held_by_role: string; status: string }[] = [];
  for (const fileRaw of files) {
    const file = normalizePath(fileRaw);
    const rows = db
      .prepare(
        `SELECT l.file_path, s.name, s.role, s.last_heartbeat, s.status, s.closed_at
         FROM locks l JOIN sessions s ON s.id = l.session_id
         WHERE l.released_at IS NULL AND l.session_id != ?`
      )
      .all(sessionId) as {
        file_path: string;
        name: string;
        role: string;
        last_heartbeat: number;
        status: any;
        closed_at: number | null;
      }[];
    for (const r of rows) {
      if (!locksOverlap(file, r.file_path)) continue;
      const status = deriveStatus(r);
      if (status === "active" || status === "suspect") {
        result.push({ file, held_file: r.file_path, held_by_name: r.name, held_by_role: r.role, status });
      }
    }
  }
  return result;
}

export function normalizePath(p: string): string {
  const trimmed = p.trim();
  // Se é path absoluto, resolve canônico. Relativo: normaliza sem resolver (sem cwd).
  return trimmed.startsWith("/") ? normalize(resolve(trimmed)) : normalize(trimmed);
}

function locksOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = lockPattern(a);
  const pb = lockPattern(b);
  if (pa.matches(b) || pb.matches(a)) return true;
  if (pa.prefix && pb.prefix) return pa.prefix.startsWith(pb.prefix) || pb.prefix.startsWith(pa.prefix);
  if (pa.prefix && pb.exact) return pb.exact.startsWith(pa.prefix);
  if (pb.prefix && pa.exact) return pa.exact.startsWith(pb.prefix);
  return false;
}

function lockPattern(raw: string): {
  exact: string | null;
  prefix: string | null;
  matches: (candidate: string) => boolean;
} {
  const value = normalizePath(raw);
  if (value.endsWith("/**")) {
    const prefix = value.slice(0, -3).replace(/\/+$/, "") + "/";
    return { exact: null, prefix, matches: (candidate) => normalizePath(candidate).startsWith(prefix) };
  }
  if (!value.includes("*")) {
    return { exact: value, prefix: null, matches: (candidate) => normalizePath(candidate) === value };
  }

  const re = new RegExp(`^${globToRegex(value)}$`);
  return { exact: null, prefix: staticPrefix(value), matches: (candidate) => re.test(normalizePath(candidate)) };
}

function staticPrefix(pattern: string): string | null {
  const idx = pattern.indexOf("*");
  if (idx < 0) return null;
  const slash = pattern.slice(0, idx).lastIndexOf("/");
  if (slash < 0) return null;
  return pattern.slice(0, slash + 1);
}

function globToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (ch === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function escapeRegex(ch: string): string {
  return /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
