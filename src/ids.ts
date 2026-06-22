import { nanoid } from "nanoid";
import type Database from "better-sqlite3";

export function newId(): string {
  return nanoid(12);
}

export function nextSessionName(db: Database.Database, role: string): string {
  const prefix = `AgentDesk-${capitalize(role)}-`;
  const rows = db
    .prepare("SELECT name FROM sessions WHERE name LIKE ?")
    .all(`${prefix}%`) as { name: string }[];

  let max = 0;
  for (const r of rows) {
    const tail = r.name.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  const next = (max + 1).toString().padStart(2, "0");
  // O caller deve retry se a inserção colidir (race entre processes).
  return `${prefix}${next}`;
}

// Nome de sessão único garantido sob race. Tenta `nextSessionName` e em caso
// de colisão UNIQUE, incrementa até pegar livre.
export function pickSessionName(db: Database.Database, role: string, candidate?: string): string {
  let name = candidate ?? nextSessionName(db, role);
  const exists = db.prepare("SELECT 1 FROM sessions WHERE name = ? LIMIT 1");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!exists.get(name)) return name;
    // Reusa nextSessionName que já lê max+1; em race ele vai pular adiante.
    name = nextSessionName(db, role);
  }
  // Fallback final: anexa sufixo random.
  return `${name}-${Math.random().toString(36).slice(2, 5)}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
