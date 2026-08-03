#!/usr/bin/env node
// Contrato E2E do fluxo autônomo do AgentDesk.
//
// Cobre o caminho que deve bastar para o usuário:
//   1. o primeiro /abrir do escopo elege um único gerente (auto ligado)
//   2. os demais workers usam apenas /abrir (sem cargo; auto ligado)
//   3. gerente atribui papéis livres e entrega uma lista de uma vez
//   4. os itens ficam prontos para agentes distintos trabalharem em paralelo
//
// Run: npm run build && node tests/autonomia.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { spawnMcp } from "./helpers/mcp-process.mjs";

const MCP_BIN = resolve(import.meta.dirname, "../dist/index.js");
const HOME_DIR = mkdtempSync(join(tmpdir(), "agentdesk-autonomia-"));
const DB_PATH = join(HOME_DIR, ".agentdesk", "agentdesk.db");
const PROJECT_DIR = join(HOME_DIR, "projeto");
const clients = [];

const env = {
  ...process.env,
  HOME: HOME_DIR,
  // Mantém compatibilidade tanto com o path derivado de HOME quanto com a
  // implementação que respeita explicitamente AGENTDESK_DB.
  AGENTDESK_DB: DB_PATH,
  AGENTDESK_BROKER_URL: "ws://127.0.0.1:1",
};

class Client {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.proc = spawnMcp(MCP_BIN, {
      env,
    });
    clients.push(this);

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
    });
    this.proc.on("exit", (code, signal) => {
      const detail = this.stderrBuffer.trim();
      for (const { reject } of this.pending.values()) {
        reject(
          new Error(
            `${this.label}: MCP encerrou antes da resposta (code=${code}, signal=${signal})` +
              (detail ? `\n${detail}` : "")
          )
        );
      }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // PTYs podem ecoar o request. Só frames de resposta resolvem promises.
      if (!("result" in message) && !("error" in message)) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const detail = this.stderrBuffer.trim();
        rejectRequest(
          new Error(
            `${this.label}: timeout em ${method}` + (detail ? `\n${detail}` : "")
          )
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: this.label, version: "0" },
    });
  }

  async tools() {
    const response = await this.request("tools/list", {});
    if (response.error) throw new Error(response.error.message);
    return response.result?.tools ?? [];
  }

  async call(name, args = {}) {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    if (response.result?.isError) {
      const message = response.result.content?.[0]?.text ?? "erro sem mensagem";
      throw new Error(message.replace(/^Erro:\s*/, ""));
    }
    return response.result;
  }

  text(result) {
    return result?.content?.find((item) => item.type === "text")?.text ?? "";
  }

  async close() {
    if (this.proc.exitCode !== null || this.proc.killed) return;
    this.proc.stdin.end();
    this.proc.kill(this.proc.agentdeskTestPty ? "SIGKILL" : "SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => this.proc.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

const results = [];

async function test(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    const ms = Date.now() - startedAt;
    results.push({ name, ok: true, ms });
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (error) {
    const ms = Date.now() - startedAt;
    results.push({ name, ok: false, ms, error: error.message });
    console.error(`  ✗ ${name} (${ms}ms): ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function value(text, key) {
  return text.match(new RegExp(`${key}:\\s*([\\w-]+)`))?.[1];
}

function openedIdentity(client, result) {
  const text = client.text(result);
  const agentId = value(text, "agent_id");
  const sessionId = value(text, "session_id");
  const name = text.match(/Agente (?:criado|retomado):\s*(\S+)/i)?.[1];
  assert(agentId, `agent_id ausente na resposta:\n${text}`);
  assert(sessionId, `session_id ausente na resposta:\n${text}`);
  return { agentId, sessionId, name, text };
}

function agentById(db, id) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

function activeSession(db, id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

async function run() {
  console.log(`\n=== AgentDesk autonomia E2E (DB=${DB_PATH}) ===\n`);

  // Inicialize o primeiro processo antes de spawnar os demais. Isso evita que
  // o teste em si introduza uma race entre migrations SQLite no primeiro boot.
  const managerClient = new Client("manager");
  await managerClient.initialize();

  let db;
  let manager;
  const workers = [];
  let batchItems = [];

  await test("/abrir não exige cargo nem tarefa", async () => {
    const tools = await managerClient.tools();
    const open = tools.find((tool) => tool.name === "abrir");
    assert(open, "tool abrir não registrada");
    const required = open.inputSchema?.required ?? [];
    assert(!required.includes("cargo"), "cargo ainda é obrigatório em /abrir");
    assert(!required.includes("tarefa"), "tarefa ainda é obrigatória em /abrir");
    assert(
      !Array.isArray(open.inputSchema?.properties?.cargo?.enum),
      "cargo ainda está preso a enum de cargos fixos"
    );
  });

  await test("primeiro /abrir elege gerente e já entra em auto", async () => {
    const result = await managerClient.call("abrir", {
      pasta: PROJECT_DIR,
      force_new: true,
    });
    manager = openedIdentity(managerClient, result);
    db = new Database(DB_PATH, { readonly: true });

    const row = agentById(db, manager.agentId);
    assert(row?.role === "gerente", `papel inicial inesperado: ${row?.role}`);
    assert(row?.auto_mode === 1, "gerente abriu com auto_mode desligado");
    manager.name = row.name;

    const auto = await managerClient.call("entrar_modo_auto", {
      session_id: manager.sessionId,
      ligar: true,
    });
    assert(
      /já estava ATIVO|ATIVO/i.test(managerClient.text(auto)),
      "/auto não é idempotente depois de /abrir"
    );
  });

  await test("segundo /abrir vira worker; force_new não duplica gerente", async () => {
    const contender = new Client("manager-contender");
    await contender.initialize();
    const secondIdentity = openedIdentity(
      contender,
      await contender.call("abrir", {
        pasta: PROJECT_DIR,
        force_new: true,
      })
    );

    const managers = db
      .prepare("SELECT id FROM agents WHERE authority = 'manager' AND status != 'archived'")
      .all();
    assert(managers.length === 1, `foram criados ${managers.length} gerentes`);
    assert(secondIdentity.agentId !== manager.agentId, "worker reutilizou identidade do gerente ativo");
    const row = agentById(db, secondIdentity.agentId);
    assert(row?.role === "disponivel", `segundo agente nasceu como ${row?.role}`);
    assert(row?.auto_mode === 1, "segundo agente abriu fora do auto");
    workers.push({ client: contender, ...secondIdentity, name: row.name });
  });

  await test("eleição concorrente cria exatamente um gerente", async () => {
    const raceFolder = join(HOME_DIR, "equipe-eleicao-race");
    const first = new Client("election-race-1");
    await first.initialize();
    const second = new Client("election-race-2");
    await second.initialize();

    const opened = await Promise.all([
      first.call("abrir", { pasta: raceFolder, force_new: true }),
      second.call("abrir", { pasta: raceFolder, force_new: true }),
    ]);
    const identities = [openedIdentity(first, opened[0]), openedIdentity(second, opened[1])];
    assert(new Set(identities.map((entry) => entry.agentId)).size === 2, "race reutilizou uma única identidade");

    const rows = db.prepare(
      "SELECT authority, role, auto_mode FROM agents WHERE folder = ? AND status != 'archived'"
    ).all(raceFolder);
    assert(rows.length === 2, `race criou ${rows.length} agentes`);
    assert(rows.filter((row) => row.authority === "manager").length === 1, "race elegeu mais de um gerente");
    assert(rows.filter((row) => row.authority === "worker").length === 1, "race não criou o worker concorrente");
    assert(rows.every((row) => row.auto_mode === 1), "algum agente da race abriu fora do auto");
  });

  await test("workers fazem apenas /abrir, sem cargo, e entram em auto", async () => {
    for (let index = workers.length; index < 3; index++) {
      // Startup sequencial mantém este teste focado no fluxo funcional; a
      // concorrência que importa é exercitada nos claims abaixo.
      const client = new Client(`worker-${index + 1}`);
      await client.initialize();
      const opened = openedIdentity(
        client,
        await client.call("abrir", {
          pasta: PROJECT_DIR,
          force_new: true,
        })
      );
      const row = agentById(db, opened.agentId);
      assert(row, `worker ${opened.agentId} não persistido`);
      assert(row.role === "disponivel", `worker sem cargo nasceu como ${row.role}`);
      assert(row.auto_mode === 1, `worker ${row.name} abriu fora do auto`);
      workers.push({ client, ...opened, name: row.name });
    }
    assert(
      new Set(workers.map((worker) => worker.agentId)).size === workers.length,
      "workers sem cargo colidiram na mesma identidade"
    );
  });

  await test("somente gerente atribui papéis livres e atualiza a sessão", async () => {
    const roles = ["pesquisa-dados", "api-pagamentos", "teste-de-carga"];
    for (let index = 0; index < workers.length; index++) {
      await managerClient.call("atribuir_papel", {
        session_id: manager.sessionId,
        agente: workers[index].agentId,
        papel: roles[index],
      });
      const agent = agentById(db, workers[index].agentId);
      const session = activeSession(db, workers[index].sessionId);
      assert(agent?.role === roles[index], `agente não recebeu papel ${roles[index]}`);
      assert(session?.role === roles[index], `sessão não recebeu papel ${roles[index]}`);
    }

    let denied = false;
    try {
      await workers[0].client.call("atribuir_papel", {
        session_id: workers[0].sessionId,
        agente: workers[1].agentId,
        papel: "papel-injetado",
      });
    } catch (error) {
      denied = /gerente|autoridade|permiss/i.test(error.message);
    }
    assert(denied, "worker conseguiu atribuir papel a outro agente");
  });

  await test("lista é distribuída atomicamente, sem duplicar e com paralelismo", async () => {
    const marker = `batch-${Date.now()}`;
    const tarefas = [
      {
        chave: "contrato",
        titulo: `${marker} pesquisar contrato`,
        descricao: "Levantar as entradas e saídas necessárias.",
        aceite: "Contrato documentado.",
        prioridade: "alta",
        papel: "pesquisa-dados",
        arquivos_ou_escopos: ["docs/**"],
      },
      {
        chave: "api",
        titulo: `${marker} implementar API`,
        descricao: "Implementar o caminho principal.",
        aceite: "Build e testes passam.",
        prioridade: "alta",
        papel: "api-pagamentos",
        arquivos_ou_escopos: ["src/**"],
      },
      {
        chave: "carga",
        titulo: `${marker} validar carga`,
        descricao: "Executar cenários independentes de validação.",
        aceite: "Relatório de validação anexado.",
        prioridade: "normal",
        papel: "teste-de-carga",
        arquivos_ou_escopos: ["tests/**"],
      },
    ];

    const result = await managerClient.call("distribuir_tarefas", {
      session_id: manager.sessionId,
      tarefas,
      estrategia: "especialidade",
      paralelismo: 3,
    });
    const output = managerClient.text(result);
    assert(output.length < 8_000, `resposta do lote desperdiça tokens (${output.length} chars)`);

    batchItems = db
      .prepare(
        `SELECT * FROM work_items
         WHERE title LIKE ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(`${marker}%`);
    assert(batchItems.length === tarefas.length, `esperava 3 itens, criou ${batchItems.length}`);
    assert(new Set(batchItems.map((item) => item.id)).size === 3, "work item duplicado no lote");
    assert(
      batchItems.every((item) => item.status === "queued"),
      `lote nasceu passivo/bloqueado: ${batchItems.map((item) => item.status).join(", ")}`
    );
    assert(
      new Set(batchItems.map((item) => item.assigned_to)).size === 3,
      `tarefas não foram espalhadas por 3 workers: ${batchItems
        .map((item) => item.assigned_to)
        .join(", ")}`
    );
    assert(
      batchItems.every((item) => !item.dependencies || item.dependencies === "[]"),
      "itens independentes ganharam dependências artificiais"
    );
  });

  await test("batch inválido não deixa criação parcial", async () => {
    const marker = `rollback-${Date.now()}`;
    let failed = false;
    try {
      await managerClient.call("distribuir_tarefas", {
        session_id: manager.sessionId,
        tarefas: [
          { chave: "duplicada", titulo: `${marker} primeiro`, papel: "pesquisa-dados" },
          { chave: "duplicada", titulo: `${marker} inválido` },
        ],
        paralelismo: 2,
      });
    } catch {
      failed = true;
    }
    assert(failed, "lote com chave duplicada foi aceito");
    const count = db
      .prepare("SELECT count(*) AS n FROM work_items WHERE title LIKE ?")
      .get(`${marker}%`).n;
    assert(count === 0, `batch parcial deixou ${count} item(ns) no banco`);
  });

  await test("ticks paralelos auto-assumem itens distintos sem nova decisão", async () => {
    const assignedByName = new Map(
      batchItems.map((item) => [item.assigned_to, item])
    );
    const itemForWorker = workers.map((worker) => {
      const item = assignedByName.get(worker.name);
      assert(item, `nenhum item diretamente atribuído a ${worker.name}`);
      return item;
    });

    const ticks = await Promise.all(
      workers.map((worker) =>
        worker.client.call("tick_autonomo", { session_id: worker.sessionId })
      )
    );
    for (let index = 0; index < workers.length; index++) {
      const output = workers[index].client.text(ticks[index]);
      assert(output.includes(itemForWorker[index].id), `${workers[index].name} não viu seu item`);
      assert(
        /assum|working|agir/i.test(output),
        `${workers[index].name} não informou a auto-assunção:\n${output}`
      );
      assert(output.length < 12_000, `tick de ${workers[index].name} excessivo (${output.length} chars)`);
    }

    const stored = db
      .prepare(
        `SELECT id, status, owner_agent_id FROM work_items
         WHERE id IN (${batchItems.map(() => "?").join(",")})`
      )
      .all(...batchItems.map((item) => item.id));
    assert(stored.every((item) => item.status === "working"), "nem todos os itens entraram em working");
    assert(
      new Set(stored.map((item) => item.owner_agent_id)).size === 3,
      "um worker monopolizou mais de um item do primeiro wave"
    );
  });

  await test("entrega só passa quando o comando de prova roda e passa", async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    const worker = workers[0];
    const item = batchItems.find((row) => row.assigned_to === worker.name);
    assert(item, `nenhum item para ${worker.name}`);

    let recusou = false;
    try {
      await worker.client.call("entregar_tarefa", {
        session_id: worker.sessionId,
        work_item_id: item.id,
        resumo: "diz que fez",
        validacao: "rodei os testes",
        comando: "exit 1",
      });
    } catch (error) {
      recusou = /Entrega recusada/.test(error.message);
    }
    assert(recusou, "entrega passou mesmo com a prova falhando");
    const aindaWorking = db.prepare("SELECT status FROM work_items WHERE id = ?").get(item.id);
    assert(aindaWorking.status === "working", `item saiu de working após prova falha: ${aindaWorking.status}`);

    await worker.client.call("entregar_tarefa", {
      session_id: worker.sessionId,
      work_item_id: item.id,
      resumo: "feito de verdade",
      validacao: "check do projeto",
      comando: "echo prova-ok",
    });
    const entregue = db.prepare("SELECT status, validation_summary FROM work_items WHERE id = ?").get(item.id);
    assert(entregue.status === "review", `item não foi para review: ${entregue.status}`);
    assert(/exit 0/.test(entregue.validation_summary), `prova não ficou registrada:\n${entregue.validation_summary}`);
    assert(/prova-ok/.test(entregue.validation_summary), `saída do comando não foi guardada:\n${entregue.validation_summary}`);
  });

  await test("tarefa de janela que sumiu volta para a fila", async () => {
    const worker = workers[2];
    const item = batchItems.find((row) => row.assigned_to === worker.name);
    assert(item, `nenhum item para ${worker.name}`);

    // Simula a janela que foi embora: 31min sem nenhuma chamada de tool.
    const writeDb = new Database(DB_PATH);
    writeDb
      .prepare("UPDATE sessions SET last_heartbeat = ?, status = 'dead' WHERE id = ?")
      .run(Date.now() - 31 * 60_000, worker.sessionId);
    writeDb.close();

    // Qualquer tool roda o sweep; o gerente serve.
    await managerClient.call("listar_status", { session_id: manager.sessionId });

    const devolvido = db
      .prepare("SELECT status, owner_agent_id, owner_session_id FROM work_items WHERE id = ?")
      .get(item.id);
    assert(devolvido.status === "queued", `item ficou preso em ${devolvido.status} com dono morto`);
    assert(!devolvido.owner_agent_id && !devolvido.owner_session_id, "item voltou para a fila mantendo o dono morto");

    const aviso = db
      .prepare("SELECT message FROM chat_messages WHERE message LIKE ? ORDER BY created_at DESC LIMIT 1")
      .get(`%${item.id}%voltou para a fila%`);
    assert(aviso, "equipe não foi avisada de que a tarefa voltou para a fila");
  });

  await test("worker não ganha autoridade administrativa pelo papel", async () => {
    // Até o texto reservado "gerente" continua sendo apenas um papel; a
    // autoridade foi eleita no /abrir e vive em coluna separada.
    await managerClient.call("atribuir_papel", {
      session_id: manager.sessionId,
      agente: workers[0].agentId,
      papel: "gerente",
    });
    const storedWorker = agentById(db, workers[0].agentId);
    assert(storedWorker.role === "gerente", "papel livre gerente não foi aceito");
    assert(storedWorker.authority === "worker", "papel gerente escalou authority");

    let denied = false;
    try {
      await workers[0].client.call("distribuir_tarefas", {
        session_id: workers[0].sessionId,
        tarefas: [{ titulo: "não deve ser criada" }],
      });
    } catch (error) {
      denied = /gerente|autoridade|permiss/i.test(error.message);
    }
    assert(denied, "papel textual concedeu poderes de gerente ao worker");
  });

  await Promise.all([...clients].reverse().map((client) => client.close()));
  db?.close();

  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`${passed}/${results.length} testes passaram.`);
  for (const result of results.filter((entry) => !entry.ok)) {
    console.log(`  ✗ ${result.name}: ${result.error}`);
  }
  console.log(`${"=".repeat(58)}\n`);

  rmSync(HOME_DIR, { recursive: true, force: true });
  process.exitCode = passed === results.length ? 0 : 1;
}

run().catch(async (error) => {
  console.error("Fatal:", error);
  await Promise.all([...clients].reverse().map((client) => client.close()));
  rmSync(HOME_DIR, { recursive: true, force: true });
  process.exitCode = 2;
});
