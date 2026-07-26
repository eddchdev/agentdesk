#!/usr/bin/env node
// Testes das correções de "time grande" (operação real com ~30 agentes).
//
// Chama os handlers direto (mesmo código que o servidor MCP expõe) com um
// banco isolado. Cada bloco cobre uma correção:
//   vida:     qualquer chamada de ferramenta renova o heartbeat
//   vida:     sessão marcada morta ressuscita ao chamar ferramenta
//
// Run: npm run build && node tests/time-grande.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agentdesk-time-grande-"));
process.env.AGENTDESK_DB = join(TMP, "agentdesk.db");
process.env.AGENTDESK_BROKER_URL = "ws://127.0.0.1:1";
delete process.env.AGENTDESK_FOLDER;
delete process.env.TMUX_PANE;

const { tools } = await import(new URL("../dist/tools.js", import.meta.url));
const { default: Database } = await import("better-sqlite3");

async function call(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} não existe`);
  const r = await tool.handler(args ?? {});
  return r.content[0].text;
}

function grab(text, key) {
  return text.match(new RegExp(`${key}:\\s*([\\w-]+)`))?.[1];
}

const results = [];
async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.error(`  ✗ ${name} (${Date.now() - start}ms): ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

console.log(`\n=== AgentDesk time-grande (DB=${process.env.AGENTDESK_DB}) ===\n`);

let db;
function rawDb() {
  db ??= new Database(process.env.AGENTDESK_DB);
  return db;
}

// ─── vida ────────────────────────────────────────────────────────────────────

await test("vida: tool que antes não renovava agora renova o heartbeat", async () => {
  const pasta = join(TMP, "equipe-vida");
  const abre = await call("abrir", { pasta, force_new: true });
  const sess = grab(abre, "session_id");
  assert(sess, `abrir não retornou session_id:\n${abre}`);

  // Envelhece para além do limite de suspeita (90s).
  const velho = Date.now() - 120_000;
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(velho, sess);

  // marcar_lido está na lista de tools que NÃO renovavam o heartbeat antes
  // da correção (só requireActiveSession, sem UPDATE last_heartbeat).
  await call("marcar_lido", { session_id: sess });

  const row = rawDb().prepare("SELECT last_heartbeat FROM sessions WHERE id = ?").get(sess);
  assert(row.last_heartbeat > velho, "chamada de ferramenta não renovou o heartbeat");
});

await test("vida: sessão marcada morta ressuscita ao chamar ferramenta", async () => {
  const pasta = join(TMP, "equipe-ressurreicao");
  const abre = await call("abrir", { pasta, force_new: true });
  const sess = grab(abre, "session_id");
  const agId = grab(abre, "agent_id");

  await call("travar_arquivos", { session_id: sess, arquivos: [join(pasta, "x.ts")] });

  // Envelhece além de DEAD_AFTER_MS (360s) e força o sweep.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
  await call("listar_status", {});

  const agMorto = rawDb().prepare("SELECT status FROM agents WHERE id = ?").get(agId);
  assert(agMorto.status === "dead", `sweep deveria marcar o agente dead, marcou ${agMorto.status}`);
  const trava = rawDb().prepare("SELECT released_at FROM locks WHERE session_id = ?").get(sess);
  assert(trava.released_at !== null, "sweep deveria liberar a trava da sessão morta");

  // Antes da correção qualquer tool aqui lançava "foi marcada como morta"
  // e forçava o cliente a abrir sessão nova (origem das duplicatas).
  const out = await call("enviar_mensagem", { session_id: sess, mensagem: "estou vivo" });
  assert(/registrada/.test(out), `enviar_mensagem falhou após a morte: ${out}`);

  const sessRow = rawDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sess);
  assert(sessRow.status === "active", `sessão não ressuscitou: ${sessRow.status}`);
  const agFinal = rawDb().prepare("SELECT status, current_session_id FROM agents WHERE id = ?").get(agId);
  assert(agFinal.status === "working", `agente não ressuscitou: ${agFinal.status}`);
  assert(agFinal.current_session_id === sess, "agente não religou à sessão ressuscitada");

  // Trava liberada pelo sweep NÃO volta sozinha: outro agente pode tê-la tomado.
  const trava2 = rawDb().prepare("SELECT released_at FROM locks WHERE session_id = ?").get(sess);
  assert(trava2.released_at !== null, "trava liberada não deve voltar sozinha na ressurreição");
});

await test("vida: sessão fechada continua rejeitada (fechado é fechado)", async () => {
  const pasta = join(TMP, "equipe-fechada");
  const abre = await call("abrir", { pasta, force_new: true });
  const sess = grab(abre, "session_id");
  await call("fechar_sessao", { session_id: sess, motivo: "fim" });
  let rejeitou = false;
  try {
    await call("enviar_mensagem", { session_id: sess, mensagem: "não deveria" });
  } catch (e) {
    rejeitou = /fechada/.test(e.message);
  }
  assert(rejeitou, "sessão fechada aceitou chamada (não pode ressuscitar fechada)");
});

// ─── painel honesto ──────────────────────────────────────────────────────────

await test("painel: suspeito e morto mostram 'sem notícias há Xmin'", async () => {
  const pasta = join(TMP, "equipe-honesta");
  const abre = await call("abrir", { pasta, force_new: true });
  const sess = grab(abre, "session_id");

  // Suspeito: 2 minutos sem notícias.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 120_000, sess);
  const status = await call("listar_status", {});
  assert(
    /suspect \(sem notícias há \d+min\)/.test(status),
    `EQUIPE ATIVA deveria anotar o tempo sem notícias:\n${status}`
  );

  // Morto: 7 minutos sem notícias; o sweep marca e a lista de agentes anota.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
  const agentes = await call("listar_agentes", {});
  assert(
    /dead \(sem notícias há \d+min\)/.test(agentes),
    `listar_agentes deveria anotar o tempo sem notícias:\n${agentes}`
  );
});

// ─── relatório ───────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`${passed}/${results.length} testes passaram.`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
console.log(`${"=".repeat(50)}\n`);

db?.close();
rmSync(TMP, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
