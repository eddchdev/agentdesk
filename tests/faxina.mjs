#!/usr/bin/env node
// Faxina: tarefa e chat antigos saem do banco; trabalho em andamento fica.
// Run: npm run build && node tests/faxina.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agentdesk-faxina-"));
process.env.AGENTDESK_DB = join(dir, "agentdesk.db");
const { getDb } = await import("../dist/db.js");
const { gcOldData } = await import("../dist/lifecycle.js");

const db = getDb();
const agora = Date.now(), DIA = 864e5, velho = agora - 10 * DIA, recente = agora - 1 * DIA;

const item = db.prepare("INSERT INTO work_items (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
item.run("fila-velha", "x", "queued", velho, velho);
item.run("bloqueada-velha", "x", "blocked", velho, velho);
item.run("feita-velha", "x", "done", velho, velho);
item.run("cancelada-velha", "x", "canceled", velho, velho);
item.run("fila-recente", "x", "queued", recente, recente);
item.run("revisao-velha", "x", "review", velho, velho);
item.run("trabalhando-velha", "x", "working", velho, velho);

const chat = db.prepare("INSERT INTO chat_messages (id, created_at, session_id, session_name, role, type, message) VALUES (?, ?, 's', 's', 'r', 'falar', 'oi')");
chat.run("chat-velho", agora - 4 * DIA);
chat.run("chat-novo", agora - 1 * DIA);

const agente = db.prepare("INSERT INTO agents (id, name, role, status, created_at, updated_at, last_seen_ms) VALUES (?, ?, 'r', 'available', ?, ?, ?)");
agente.run("ag-sumido", "Sumido", velho, velho, velho);
agente.run("ag-ativo", "Ativo", velho, velho, agora);

const r = gcOldData(db);

const ids = db.prepare("SELECT id FROM work_items ORDER BY id").all().map((x) => x.id);
assert.deepEqual(ids, ["fila-recente", "revisao-velha", "trabalhando-velha"], "só fica o recente e o que está em andamento");
assert.equal(r.work_items_apagados, 4);
assert.deepEqual(db.prepare("SELECT id FROM chat_messages").all().map((x) => x.id), ["chat-novo"], "chat com mais de 3 dias sai");
const st = Object.fromEntries(db.prepare("SELECT id, status FROM agents").all().map((x) => [x.id, x.status]));
assert.equal(st["ag-sumido"], "archived", "agente sem sinal há 7 dias é arquivado");
assert.equal(st["ag-ativo"], "available", "agente com sinal recente fica");

db.close();
rmSync(dir, { recursive: true, force: true });
console.log("faxina: ok");
