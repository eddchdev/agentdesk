#!/usr/bin/env node
// Testes de concorrência multiprocesso. Cobrem defeitos achados em revisão
// adversarial das correções de time grande:
//   1. o sweep de um processo não pode condenar uma sessão que outro processo
//      acabou de renovar (a decisão de vida precisa acontecer dentro da
//      transação IMMEDIATE, com snapshot fresco)
//
// Run: npm run build && node tests/concorrencia.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "agentdesk-concorrencia-"));
const DB = join(TMP, "agentdesk.db");
process.env.AGENTDESK_DB = DB;
process.env.AGENTDESK_BROKER_URL = "ws://127.0.0.1:1";
delete process.env.AGENTDESK_FOLDER;

const { tools } = await import(new URL("../dist/tools.js", import.meta.url));
const { default: Database } = await import("better-sqlite3");
const call = (name, args) => tools.find((t) => t.name === name).handler(args).content[0].text;

console.log(`\n=== AgentDesk concorrência (DB=${DB}) ===\n`);

const results = [];
function report(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` (${extra})` : ""}`);
}

function spawnNode(file, args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [file, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => res({ code, out: out.trim() }));
  });
}

// ─── 1. sweep vs renovação de vida ───────────────────────────────────────────
// Vítima: fica "7min sem notícias" e acorda chamando uma ferramenta (renova).
// Varredor: outro processo rodando sweepSessions sem parar. Se em algum
// momento a sessão terminar 'dead' COM heartbeat fresco, o sweep decidiu com
// leitura velha e matou uma sessão viva (soltando as travas dela).

const VITIMA = join(TMP, "vitima.mjs");
writeFileSync(VITIMA, `
const [dbPath, sessionId, deadlineArg, dist] = process.argv.slice(2);
process.env.AGENTDESK_DB = dbPath;
process.env.AGENTDESK_BROKER_URL = "ws://127.0.0.1:1";
const { getDb } = await import(dist + "/db.js");
const { requireActiveSession } = await import(dist + "/lifecycle.js");
const db = getDb();
const deadline = Number(deadlineArg);
const stale = db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?");
const readS = db.prepare("SELECT status, last_heartbeat FROM sessions WHERE id = ?");
let iters = 0;
while (Date.now() < deadline) {
  iters++;
  stale.run(Date.now() - 7 * 60000, sessionId);
  const tsBefore = Date.now();
  requireActiveSession(db, sessionId);
  const row = readS.get(sessionId);
  if (row.status === "dead" && row.last_heartbeat >= tsBefore) {
    console.log(JSON.stringify({ corrompeu: true, iters }));
    process.exit(0);
  }
}
console.log(JSON.stringify({ corrompeu: false, iters }));
process.exit(0);
`);

const VARREDOR = join(TMP, "varredor.mjs");
writeFileSync(VARREDOR, `
const [dbPath, deadlineArg, dist] = process.argv.slice(2);
process.env.AGENTDESK_DB = dbPath;
process.env.AGENTDESK_BROKER_URL = "ws://127.0.0.1:1";
const { getDb } = await import(dist + "/db.js");
const { sweepSessions } = await import(dist + "/lifecycle.js");
const db = getDb();
const deadline = Number(deadlineArg);
while (Date.now() < deadline) sweepSessions(db);
process.exit(0);
`);

{
  const aberto = call("abrir_sessao", {
    cargo: "backend",
    tarefa: "vitima-do-sweep",
    pasta: join(TMP, "proj-toctou"),
  });
  const sessionId = aberto.match(/\(id=([\w-]+)\)/)?.[1];
  call("travar_arquivos", { session_id: sessionId, arquivos: ["src/a.ts"] });
  const deadline = Date.now() + 12_000;
  const [v] = await Promise.all([
    spawnNode(VITIMA, [DB, sessionId, String(deadline), DIST]),
    spawnNode(VARREDOR, [DB, String(deadline), DIST]),
  ]);
  const r = JSON.parse(v.out.split("\n").pop());
  report(
    "sweep não condena sessão que acabou de dar sinal de vida",
    r.corrompeu === false,
    `${r.iters} iterações em 12s${r.corrompeu ? "; CORROMPEU: dead com heartbeat fresco" : ""}`
  );
}

// ─── relatório ───────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`${passed}/${results.length} testes passaram.`);
console.log(`${"=".repeat(50)}\n`);
rmSync(TMP, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
