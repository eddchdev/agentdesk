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
  const status = await call("listar_status", { pasta });
  assert(
    /suspect \(sem notícias há \d+min\)/.test(status),
    `EQUIPE ATIVA deveria anotar o tempo sem notícias:\n${status}`
  );

  // Morto: 7 minutos sem notícias; o sweep marca e a lista de agentes anota.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
  const agentes = await call("listar_agentes", { pasta });
  assert(
    /dead \(sem notícias há \d+min\)/.test(agentes),
    `listar_agentes deveria anotar o tempo sem notícias:\n${agentes}`
  );
});

// ─── sessão única por cargo+tarefa ───────────────────────────────────────────

await test("abrir_sessao: recusa duplicar cargo+tarefa com sessão viva", async () => {
  const pasta = join(TMP, "equipe-dedup");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "arreio-canal-oficial", pasta });
  assert(/Sessão aberta/.test(um), `primeira abertura falhou:\n${um}`);

  let recusa = null;
  try {
    await call("abrir_sessao", { cargo: "executor", tarefa: "arreio-canal-oficial", pasta });
  } catch (e) {
    recusa = e.message;
  }
  assert(
    recusa && /Já existe .* trabalhando nesta mesma tarefa/.test(recusa),
    `segunda abertura deveria ser recusada dizendo quem já está lá: ${recusa}`
  );
  const n1 = rawDb().prepare("SELECT COUNT(*) AS n FROM agents WHERE team_key = ?").get(`folder:${pasta}`).n;
  assert(n1 === 1, `esperava 1 agente na equipe após a recusa, tem ${n1}`);

  const dois = await call("abrir_sessao", {
    cargo: "executor", tarefa: "arreio-canal-oficial", pasta, force_new: true,
  });
  assert(/Sessão aberta/.test(dois), `force_new=true deveria criar mesmo assim:\n${dois}`);
});

await test("abrir_sessao: sessão morta com mesmo cargo+tarefa é retomada, não clonada", async () => {
  const pasta = join(TMP, "equipe-dedup-morta");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "arreio-canal-oficial", pasta });
  const sessId = um.match(/\(id=([\w-]+)\)/)?.[1];
  const agentId = um.match(/\[id=([\w-]+)\]/)?.[1];
  assert(sessId && agentId, `não achei ids na saída:\n${um}`);

  // Sessão fica 7 minutos sem notícias; sweep marca morta e libera tudo.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sessId);
  await call("listar_status", {});

  const dois = await call("abrir_sessao", { cargo: "executor", tarefa: "arreio-canal-oficial", pasta });
  assert(/Sessão retomada \(não duplicada\)/.test(dois), `deveria retomar a sessão morta:\n${dois}`);
  assert(dois.includes(agentId), `retomada não reaproveitou o mesmo agente:\n${dois}`);
  const n = rawDb().prepare("SELECT COUNT(*) AS n FROM agents WHERE team_key = ?").get(`folder:${pasta}`).n;
  assert(n === 1, `retomada criou agente novo (total ${n})`);
  const sess = rawDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sessId);
  assert(sess.status === "active", `sessão retomada deveria estar active: ${sess.status}`);
});

// ─── faxina de tarefa zumbi ──────────────────────────────────────────────────

await test("faxina: auto-close devolve as tasks da sessão (sem zumbi in_progress)", async () => {
  const pasta = join(TMP, "equipe-zumbi");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-zumbi", pasta });
  const sessId = um.match(/\(id=([\w-]+)\)/)?.[1];
  assert(sessId, `não achei session_id:\n${um}`);

  // 40 minutos sem notícias: passa do limite de auto-close (30min).
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 40 * 60_000, sessId);
  await call("listar_status", {});

  const sess = rawDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sessId);
  assert(sess.status === "closed", `sessão deveria auto-fechar: ${sess.status}`);
  const task = rawDb().prepare("SELECT status FROM tasks WHERE session_id = ?").get(sessId);
  assert(task.status === "pending", `task deveria voltar para 'pending', ficou '${task.status}'`);
});

// ─── escopo por equipe ───────────────────────────────────────────────────────

await test("painel: filtra pela equipe por padrão; todas_equipes mostra tudo", async () => {
  const pastaA = join(TMP, "proj-escopo-a");
  const pastaB = join(TMP, "proj-escopo-b");
  const a = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-escopo-a", pasta: pastaA });
  const b = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-escopo-b", pasta: pastaB });
  const sessA = a.match(/\(id=([\w-]+)\)/)?.[1];
  const sessB = b.match(/\(id=([\w-]+)\)/)?.[1];
  await call("enviar_mensagem", { session_id: sessA, mensagem: "conversa do projeto A" });
  await call("enviar_mensagem", { session_id: sessB, mensagem: "conversa do projeto B" });

  const soA = await call("listar_status", { pasta: pastaA });
  assert(soA.includes("tarefa-escopo-a"), `equipe A sumiu do próprio painel:\n${soA}`);
  assert(!soA.includes("tarefa-escopo-b"), `painel da equipe A vazou a equipe B:\n${soA}`);

  const chatA = await call("listar_chat", { session_id: sessA });
  assert(
    chatA.includes("conversa do projeto A") && !chatA.includes("conversa do projeto B"),
    `chat da equipe A veio misturado:\n${chatA}`
  );

  const tudo = await call("listar_status", { todas_equipes: true });
  assert(
    tudo.includes("tarefa-escopo-a") && tudo.includes("tarefa-escopo-b"),
    "todas_equipes=true deveria mostrar as duas equipes"
  );
});

// ─── fim do balde 'default' ──────────────────────────────────────────────────

await test("equipes: sem pasta informada, herda a pasta do ambiente", async () => {
  const pasta = join(TMP, "proj-env");
  process.env.AGENTDESK_FOLDER = pasta;
  try {
    const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-env" });
    const sessId = um.match(/\(id=([\w-]+)\)/)?.[1];
    const row = rawDb().prepare("SELECT team_key FROM sessions WHERE id = ?").get(sessId);
    assert(row.team_key === `folder:${pasta}`, `team_key deveria vir do ambiente, veio '${row.team_key}'`);
  } finally {
    delete process.env.AGENTDESK_FOLDER;
  }

  // Sem pasta e sem env: usa a pasta do processo, nunca o balde 'default'.
  const dois = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-cwd" });
  const sessId2 = dois.match(/\(id=([\w-]+)\)/)?.[1];
  const row2 = rawDb().prepare("SELECT team_key FROM sessions WHERE id = ?").get(sessId2);
  assert(
    row2.team_key !== "default" && row2.team_key.startsWith("folder:"),
    `sessão sem pasta caiu no balde errado: '${row2.team_key}'`
  );
});

// ─── arquivamento de agente morto antigo ─────────────────────────────────────

await test("faxina: agente morto há mais de 7 dias é arquivado, não apagado", async () => {
  const pasta = join(TMP, "equipe-arquivo");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-antiga", pasta });
  const agentId = um.match(/\[id=([\w-]+)\]/)?.[1];
  const sessId = um.match(/\(id=([\w-]+)\)/)?.[1];
  assert(agentId && sessId, `não achei ids:\n${um}`);

  // Morre e fica 8 dias sem qualquer notícia.
  const oitoDias = Date.now() - 8 * 24 * 60 * 60 * 1000;
  rawDb().prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(oitoDias, sessId);
  rawDb().prepare(
    "UPDATE agents SET status = 'dead', updated_at = ?, current_session_id = NULL WHERE id = ?"
  ).run(oitoDias, agentId);

  const { gcOldData } = await import(new URL("../dist/lifecycle.js", import.meta.url));
  const gc = gcOldData(rawDb());
  assert(gc.agents >= 1, `gc deveria arquivar pelo menos 1 agente, arquivou ${gc.agents}`);

  const ag = rawDb().prepare("SELECT status FROM agents WHERE id = ?").get(agentId);
  assert(ag.status === "archived", `agente deveria estar arquivado: ${ag.status}`);

  const padrao = await call("listar_agentes", { pasta });
  assert(!padrao.includes(agentId), "arquivado ainda aparece na listagem padrão");
  const completo = await call("listar_agentes", { pasta, incluir_arquivados: true });
  assert(completo.includes(agentId), "arquivado sumiu do histórico (incluir_arquivados)");
});

// ─── entrada única ───────────────────────────────────────────────────────────

await test("abrir: entrada única traz inbox, equipe, fila, travas e chat numa resposta só", async () => {
  const pasta = join(TMP, "equipe-entrada");
  const g = await call("abrir", { pasta, force_new: true });
  const gSess = grab(g, "session_id");
  await call("enviar_mensagem", { session_id: gSess, mensagem: "decisão: API usa REST" });
  await call("travar_arquivos", { session_id: gSess, arquivos: [join(pasta, "src/db.ts")] });
  await call("distribuir_tarefas", {
    session_id: gSess,
    estrategia: "fila",
    tarefas: [
      { titulo: "primeira tarefa da fila", papel: "executor" },
      { titulo: "segunda tarefa da fila", papel: "executor" },
    ],
  });

  // Um trabalhador entra com UMA chamada, declarando um arquivo extra.
  const w = await call("abrir", { pasta, force_new: true, arquivos_pretendidos: [join(pasta, "src", "novo.ts")] });
  assert(w.includes("decisão: API usa REST"), `entrada sem o chat recente:\n${w}`);
  assert(/EQUIPE ATIVA/.test(w), "entrada sem a lista da equipe");
  assert(/WORK ITEMS ESTRUTURADOS/.test(w), "entrada sem a fila de work items");
  assert(/TRAVAS ATIVAS/.test(w) && w.includes("src/db.ts"), "entrada sem as travas da equipe");
  assert(/INBOX de/.test(w), "entrada sem inbox");
  assert(
    /travas concedidas na entrada/.test(w) && w.includes("novo.ts"),
    "não travou o arquivo declarado na entrada"
  );

  // Arquivo já travado por outro é recusado dizendo quem segura.
  const w2 = await call("abrir", { pasta, force_new: true, arquivos_pretendidos: [join(pasta, "src/db.ts")] });
  assert(/trava recusada/.test(w2), `deveria recusar a trava em conflito na entrada:\n${w2}`);
});

// ─── handoff com contexto ────────────────────────────────────────────────────

await test("handoff: quem recebe vê o que foi decidido e tentado, não só a nota", async () => {
  const pasta = join(TMP, "equipe-handoff");
  const a = await call("abrir_sessao", { cargo: "executor", tarefa: "migrar canal", pasta });
  const sessA = a.match(/\(id=([\w-]+)\)/)?.[1];
  await call("atualizar_progresso", { session_id: sessA, progresso: "Tentei via API v1, falhou por auth" });
  await call("atualizar_progresso", { session_id: sessA, progresso: "Decidi usar fila local, falta teste" });
  await call("passar_tarefa", { session_id: sessA, destinatario: "revisor", nota: "continua daqui" });

  const b = await call("abrir_sessao", { cargo: "revisor", tarefa: "assumir handoff", pasta });
  const agB = b.match(/\[id=([\w-]+)\]/)?.[1];
  const inbox = await call("inbox_agente", { agent: agB });
  assert(inbox.includes("continua daqui"), `inbox sem a nota do handoff:\n${inbox}`);
  assert(inbox.includes("migrar canal"), `handoff sem o título da tarefa:\n${inbox}`);
  assert(inbox.includes("Tentei via API v1, falhou por auth"), `handoff sem o histórico de tentativas:\n${inbox}`);
  assert(inbox.includes("Decidi usar fila local"), `handoff sem as decisões de quem passou:\n${inbox}`);
});

// ─── corridas de abertura (revisão adversarial) ──────────────────────────────

await test("retomada não sequestra agente que já está ativo em outra sessão", async () => {
  const pasta = join(TMP, "equipe-sequestro");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-seq", pasta });
  const sess1 = um.match(/\(id=([\w-]+)\)/)?.[1];
  const agentId = um.match(/\[id=([\w-]+)\]/)?.[1];

  // Sessão 1 morre; o agente é retomado e passa a trabalhar numa sessão NOVA.
  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess1);
  await call("listar_status", { pasta });
  const dois = await call("abrir", { pasta, retomar_agente_id: agentId });
  const sess2 = grab(dois, "session_id");
  assert(sess2 && sess2 !== sess1, `retomada deveria usar sessão nova (veio ${sess2})`);

  // Janela intrusa tenta abrir a mesma tarefa da sessão morta: não pode
  // repontar o agente (sequestro) nem reabrir a sessão antiga por baixo dele.
  let recusa = null;
  try {
    await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-seq", pasta });
  } catch (e) {
    recusa = e.message;
  }
  const ag = rawDb().prepare("SELECT current_session_id FROM agents WHERE id = ?").get(agentId);
  assert(
    ag.current_session_id === sess2,
    `agente foi sequestrado: aponta para ${ag.current_session_id}, deveria seguir em ${sess2} (recusa=${recusa})`
  );
});

await test("retomada reaproveita a task do mesmo título (sem pilha de in_progress)", async () => {
  const pasta = join(TMP, "equipe-pilha");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-pilha", pasta });
  const sess = um.match(/\(id=([\w-]+)\)/)?.[1];

  for (let ciclo = 1; ciclo <= 3; ciclo++) {
    rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
    await call("listar_status", { pasta });
    const r = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-pilha", pasta });
    assert(/retomada/.test(r), `ciclo ${ciclo}: deveria retomar a sessão morta:\n${r}`);
  }

  const n = rawDb().prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE session_id = ? AND status = 'in_progress'"
  ).get(sess).n;
  assert(n === 1, `3 restarts deveriam manter 1 task in_progress, tem ${n}`);
  const feito = await call("marcar_feito", { session_id: sess, resumo: "fim sem ambiguidade" });
  assert(/concluída/.test(feito), `marcar_feito falhou: ${feito}`);
});

// ─── leitura sem efeito colateral ────────────────────────────────────────────

await test("painel: consultar session_id de agente morto NÃO o ressuscita", async () => {
  const pasta = join(TMP, "equipe-leitura");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-leitura", pasta });
  const sess = um.match(/\(id=([\w-]+)\)/)?.[1];
  const agentId = um.match(/\[id=([\w-]+)\]/)?.[1];

  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
  await call("listar_status", { pasta });
  const antes = rawDb().prepare("SELECT status FROM agents WHERE id = ?").get(agentId);
  assert(antes.status === "dead", `setup: agente deveria estar dead, está ${antes.status}`);

  // Painel/gerente consultando com o session_id guardado: leitura pura.
  const visto = await call("listar_status", { session_id: sess });
  assert(visto.includes(`folder:${pasta}`), `escopo deveria vir da sessão consultada:\n${visto.split("\n")[0]}`);
  const depois = rawDb().prepare("SELECT status FROM agents WHERE id = ?").get(agentId);
  const sessRow = rawDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sess);
  assert(depois.status === "dead", `leitura ressuscitou o agente: ${depois.status}`);
  assert(sessRow.status === "dead", `leitura ressuscitou a sessão: ${sessRow.status}`);
});

await test("painel: filtro por projeto alcança equipes project:*", async () => {
  const r = await call("listar_status", { projeto: "legado-x" });
  assert(r.includes("EQUIPE: project:legado-x"), `filtro por projeto não resolveu:\n${r.split("\n")[0]}`);
});

// ─── ressurreição avisada ────────────────────────────────────────────────────

await test("vida: ressurreição avisa quais travas se perderam e restaura a task", async () => {
  const pasta = join(TMP, "equipe-aviso");
  const um = await call("abrir_sessao", { cargo: "executor", tarefa: "tarefa-aviso", pasta });
  const sess = um.match(/\(id=([\w-]+)\)/)?.[1];
  const agentId = um.match(/\[id=([\w-]+)\]/)?.[1];
  await call("travar_arquivos", { session_id: sess, arquivos: [join(pasta, "critico.ts")] });

  rawDb().prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(Date.now() - 400_000, sess);
  await call("listar_status", { pasta });
  const morto = rawDb().prepare("SELECT current_task_id FROM agents WHERE id = ?").get(agentId);
  assert(morto.current_task_id === null, "setup: sweep deveria zerar o ponteiro da task");

  await call("atualizar_progresso", { session_id: sess, progresso: "acordei" });
  const vivo = rawDb().prepare("SELECT current_task_id, status FROM agents WHERE id = ?").get(agentId);
  assert(vivo.status === "working", `agente não voltou a working: ${vivo.status}`);
  assert(vivo.current_task_id, "ressurreição deveria restaurar o ponteiro da task em andamento");

  const chat = await call("listar_chat", { pasta, limite: 10 });
  assert(
    /Travas liberadas nesse período/.test(chat) && chat.includes("critico.ts"),
    `faltou o alerta de travas perdidas no chat:\n${chat}`
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
