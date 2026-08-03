import { z } from "zod";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getDb, now } from "./db.js";
import { newId, pickSessionName } from "./ids.js";
import {
  deriveStatus,
  recordEvent,
  requireActiveSession,
  sweepSessions,
  type SessionRow,
} from "./lifecycle.js";
import {
  acquireLocks,
  activeLocks,
  detectConflicts,
  releaseLocks,
} from "./locks.js";
import { formatChatLine, listChat, postChat, type ChatType } from "./chat.js";
import { notify } from "./notifier.js";
import {
  claimNextReadyWorkItem,
  claimWorkItem,
  createWorkItem,
  dependenciesReady,
  getWorkItem,
  listWorkItems,
  parseJsonList,
  updateWorkItemStatus,
  type WorkItemRow,
} from "./work-items.js";
import { integrarWorktree, prepareWorktree } from "./worktree.js";
import {
  assignAgentRole,
  createOrGetManager,
  createAgent,
  deriveTeamKey,
  findManagerForTeam,
  findMatchingAgents,
  findAgentByName,
  findAgentById,
  getAgentByIdentifier,
  getAgentForSession,
  isManagerAgent,
  listAgents,
  listAgentsForTeam,
  markAgentSeen,
  pickUniqueName,
  setAgentAutoMode,
  setAgentStatus,
  touchAgent,
  type AgentRow,
  type AgentStatus,
} from "./agents.js";

function envTmuxPane(): string | null {
  return process.env.TMUX_PANE || null;
}

// Compatibilidade com clientes antigos. O fluxo novo não oferece catálogo de
// cargos: `gerente` é autoridade e todos os demais papéis são texto livre,
// atribuído pelo gerente conforme o lote de trabalho.
const MANAGER_ROLE = "gerente";
const AVAILABLE_ROLE = "disponivel";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

type ToolHandler = (args: any) => Promise<any> | any;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: ToolHandler;
}

function getSessionByIdentifier(db: Database.Database, idOrName: string): SessionRow | null {
  let row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(idOrName) as SessionRow | undefined;
  if (!row) {
    row = db.prepare("SELECT * FROM sessions WHERE name = ?").get(idOrName) as SessionRow | undefined;
  }
  return row ?? null;
}

function getManagerForSession(db: Database.Database, session: SessionRow): AgentRow {
  const agent = getAgentByActiveSession(db, session.id);
  if (!agent || !isManagerAgent(agent)) {
    throw new Error("Esta ação exige a autoridade do gerente eleito da equipe.");
  }
  return agent;
}

function teamKeyForSession(session: SessionRow, agent?: AgentRow | null): string {
  return (session as SessionRow & { team_key?: string }).team_key
    || agent?.team_key
    || deriveTeamKey(session.folder, session.project);
}

function adoptWorkItemRole(
  db: Database.Database,
  session: SessionRow,
  agent: AgentRow,
  item: WorkItemRow
) {
  const role = item.assigned_role?.trim();
  if (!role || isManagerAgent(agent) || role === agent.role) return;
  const ts = now();
  db.prepare(
    "UPDATE agents SET role = ?, role_assigned_by = COALESCE(role_assigned_by, 'fila-auto'), role_assigned_at = ?, updated_at = ? WHERE id = ?"
  ).run(role, ts, ts, agent.id);
  db.prepare("UPDATE sessions SET role = ?, task = ? WHERE id = ?").run(role, item.title, session.id);
  db.prepare("UPDATE tasks SET title = ?, description = ?, updated_at = ? WHERE id = ?")
    .run(item.title, item.description ?? item.title, ts, agent.current_task_id);
  agent.role = role;
  session.role = role;
}

function autoClaimNext(
  db: Database.Database,
  session: SessionRow,
  agent: AgentRow
): WorkItemRow | null {
  if (isManagerAgent(agent)) return null;
  const teamKey = teamKeyForSession(session, agent);
  for (let attempt = 0; attempt < 10; attempt++) {
    let item = db.prepare(
      `SELECT * FROM work_items
       WHERE owner_agent_id = ? AND status = 'working' AND team_key = ?
       ORDER BY updated_at DESC LIMIT 1`
    ).get(agent.id, teamKey) as WorkItemRow | undefined;
    const wasAlreadyWorking = !!item;
    if (!item) {
      item = claimNextReadyWorkItem(db, {
        agent_id: agent.id,
        agent_name: agent.name,
        agent_role: agent.role,
        session_id: session.id,
        team_key: teamKey,
        folder: session.folder || agent.folder,
        allow_role_adoption: agent.role === AVAILABLE_ROLE,
      }) ?? undefined;
    }
    if (!item) return null;

    adoptWorkItemRole(db, session, agent, item);
    const scopes = parseJsonList(item.intended_files);
    if (scopes.length) {
      const locks = acquireLocks(
        db,
        session.id,
        scopes,
        parseJsonList(item.areas)[0],
        { id: agent.id, name: agent.name }
      );
      if (locks.conflicts.length) {
        releaseLocks(db, session.id, scopes);
        const reason = `Conflito de lock: ${locks.conflicts
          .map((conflict) => `${conflict.file} vs ${conflict.held_file} por ${conflict.held_by_name}`)
          .join("; ")}`;
        updateWorkItemStatus(db, item.id, "blocked", { blocked_reason: reason });
        db.prepare(
          `UPDATE work_items
           SET owner_agent_id = NULL, owner_agent_name = NULL, owner_session_id = NULL
           WHERE id = ?`
        ).run(item.id);
        recordEvent(db, session.id, "work_item.auto_skipped_lock", { id: item.id, reason });
        continue;
      }
    }

    if (!item.worktree_path) {
      const folder = item.folder || session.folder || agent.folder;
      if (folder) {
        try {
          const worktree = prepareWorktree({
            folder,
            agentName: agent.name,
            workItemId: item.id,
            title: item.title,
          });
          item = updateWorkItemStatus(db, item.id, "working", {
            worktree_path: worktree.path,
            branch_name: worktree.branch,
          });
        } catch (error: any) {
          recordEvent(db, session.id, "work_item.worktree_failed", {
            id: item.id,
            error: error?.message ?? String(error),
          });
        }
      }
    }

    if (!wasAlreadyWorking) {
      recordEvent(db, session.id, "work_item.auto_claimed", {
        id: item.id,
        agent: agent.name,
        role: item.assigned_role,
      });
    }
    return getWorkItem(db, item.id) ?? item;
  }
  return null;
}

// Escopo padrão das tools de leitura. Com 4 projetos e 30+ agentes no mesmo
// banco, o painel sem filtro vira lixo: o padrão agora é a equipe do chamador
// (sessão > pasta explícita > AGENTDESK_FOLDER do Electron > cwd do processo
// MCP, que o Claude Code inicia na pasta do projeto). todas_equipes=true é o
// jeito explícito de ver tudo.
function resolveTeamScope(db: Database.Database, args: any): string | null {
  if (args?.todas_equipes) return null;
  if (args?.session_id) {
    // Leitura pura, sem efeito colateral: descobrir a equipe NÃO é sinal de
    // vida do alvo. Um painel ou gerente consultando o session_id de um
    // agente morto não pode ressuscitá-lo (isso mantinha mortos "vivos" para
    // sempre). Sessão fechada ainda resolve a equipe dela, que é o escopo
    // mais preciso que existe.
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(args.session_id) as SessionRow | undefined;
    if (session) {
      const agente = session.agent_id ? findAgentById(db, session.agent_id) : null;
      return teamKeyForSession(session, agente);
    }
  }
  const pasta = typeof args?.pasta === "string" && args.pasta.trim() ? args.pasta.trim() : null;
  const projeto = typeof args?.projeto === "string" && args.projeto.trim() ? args.projeto.trim() : null;
  // pasta/projeto explícitos ganham do ambiente; sem eles, a equipe é a da
  // pasta do processo (Claude Code inicia o servidor na pasta do projeto).
  if (pasta || projeto) return deriveTeamKey(pasta, projeto);
  return deriveTeamKey(process.env.AGENTDESK_FOLDER || process.cwd(), null);
}

const ESCOPO_PROPS = {
  session_id: { type: "string", description: "Escopo preferido: usa a equipe desta sessão (leitura pura, não renova heartbeat)." },
  pasta: { type: "string", description: "Escopo alternativo: pasta da equipe." },
  projeto: { type: "string", description: "Escopo alternativo: nome do projeto (equipes project:*)." },
  todas_equipes: { type: "boolean", default: false, description: "Mostra todas as equipes (visão global explícita)." },
} as const;

// Medição da produção. Mediana e p90 em vez de média: uma tarefa esquecida
// aberta a noite toda distorce a média e some na mediana.
function quantil(valores: number[], q: number): number {
  if (!valores.length) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const indice = Math.min(ordenados.length - 1, Math.round(q * (ordenados.length - 1)));
  return ordenados[indice];
}

// Tempo de relógio em que pelo menos uma tarefa esteve em execução. Somar as
// durações direto contaria duas vezes o que rodou em paralelo, que é
// justamente o que se quer medir.
function uniaoMs(intervalos: Array<[number, number]>): number {
  const ordenados = intervalos.filter(([ini, fim]) => fim > ini).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let ini = 0;
  let fim = 0;
  let aberto = false;
  for (const [a, b] of ordenados) {
    if (!aberto) {
      ini = a;
      fim = b;
      aberto = true;
    } else if (a <= fim) {
      fim = Math.max(fim, b);
    } else {
      total += fim - ini;
      ini = a;
      fim = b;
    }
  }
  return aberto ? total + (fim - ini) : total;
}

function dur(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "menos de 1min";
  if (min < 90) return `${min}min`;
  const horas = Math.floor(min / 60);
  const resto = min % 60;
  if (horas < 48) return resto ? `${horas}h${String(resto).padStart(2, "0")}` : `${horas}h`;
  return `${Math.round(horas / 24)} dias`;
}

function cabecalhoEscopo(teamKey: string | null): string {
  return teamKey
    ? `EQUIPE: ${teamKey}  (use todas_equipes=true para ver todas)`
    : "EQUIPE: todas";
}

// O sistema não sabe se um processo morreu; só sabe há quanto tempo não tem
// notícia dele. "dead"/"suspect" secos afirmavam mais do que o sistema sabe
// (e mentiam para agente que passa 20min só lendo código). A anotação diz o
// fato observável.
function idadeHumana(lastMs: number): string {
  const min = Math.max(1, Math.round((now() - lastMs) / 60_000));
  return min < 60
    ? `${min}min`
    : min < 48 * 60
      ? `${Math.round(min / 60)}h`
      : `${Math.round(min / (24 * 60))} dias`;
}

function anotaSemNoticias(status: string, lastMs: number): string {
  if (status !== "dead" && status !== "suspect") return status;
  return `${status} (sem notícias há ${idadeHumana(lastMs)})`;
}

function renderTeamContext(db: Database.Database, teamKey?: string | null): string {
  sweepSessions(db);
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE status IN ('active','suspect') AND (? IS NULL OR team_key = ?) ORDER BY opened_at ASC")
    .all(teamKey ?? null, teamKey ?? null) as SessionRow[];

  if (!sessions.length) return "Nenhuma sessão ativa no momento.";

  const lines: string[] = ["EQUIPE ATIVA:"];
  for (const s of sessions) {
    const status = deriveStatus(s);
    const areas = parseJsonList(s.areas).join(", ") || "—";
    const files = parseJsonList(s.intended_files).join(", ") || "—";
    lines.push(
      `- ${s.name} [${s.role}] status=${anotaSemNoticias(status, s.last_heartbeat)}
    tarefa: ${s.task ?? "—"}
    projeto: ${s.project ?? "—"}  pasta: ${s.folder ?? "—"}
    áreas: ${areas}
    arquivos pretendidos: ${files}`
    );
  }
  return lines.join("\n");
}

function renderLocks(db: Database.Database, teamKey?: string | null): string {
  const locks = activeLocks(db, 100, teamKey);
  if (!locks.length) return "Sem travas ativas.";
  const lines = ["TRAVAS ATIVAS:"];
  for (const l of locks) {
    lines.push(`- ${l.file_path}  ←  ${l.session_name} [${l.session_role}]${l.area ? ` (área: ${l.area})` : ""}`);
  }
  return lines.join("\n");
}

function renderTasks(db: Database.Database, teamKey?: string | null): string {
  const rows = db
    .prepare(
      `SELECT t.*, s.name as session_name FROM tasks t
       JOIN sessions s ON s.id = t.session_id
       WHERE t.status IN ('in_progress','pending') AND (? IS NULL OR s.team_key = ?)
       ORDER BY t.updated_at DESC LIMIT 20`
    )
    .all(teamKey ?? null, teamKey ?? null) as Array<{ id: string; title: string; status: string; session_name: string }>;
  if (!rows.length) return "Sem tarefas em aberto.";
  const lines = ["TAREFAS EM ABERTO:"];
  for (const t of rows) lines.push(`- [${t.status}] ${t.session_name}: ${t.title}`);
  return lines.join("\n");
}

function renderWorkItems(db: Database.Database, teamKey?: string | null): string {
  const rows = listWorkItems(db, { limit: 12, team_key: teamKey }).filter((w) => !["done", "canceled"].includes(w.status));
  if (!rows.length) return "Sem work items estruturados abertos.";
  const lines = ["WORK ITEMS ESTRUTURADOS:"];
  for (const w of rows) {
    const owner = w.owner_agent_name ? ` dono=${w.owner_agent_name}` : "";
    const assigned = w.assigned_to || w.assigned_role ? ` alvo=${w.assigned_to ?? w.assigned_role}` : "";
    lines.push(`- ${w.id} [${w.status}/${w.priority}]${owner}${assigned}: ${w.title}`);
    if (w.blocked_reason) lines.push(`    bloqueio: ${w.blocked_reason}`);
  }
  return lines.join("\n");
}

function formatWorkItem(w: WorkItemRow): string {
  const areas = parseJsonList(w.areas).join(", ") || "—";
  const files = parseJsonList(w.intended_files).join(", ") || "—";
  const deps = parseJsonList(w.dependencies).join(", ") || "—";
  return [
    `${w.id} [${w.status}/${w.priority}] ${w.title}`,
    `alvo: ${w.assigned_to ?? w.assigned_role ?? "—"}  dono: ${w.owner_agent_name ?? "—"}`,
    `pasta: ${w.folder ?? "—"}`,
    `áreas: ${areas}`,
    `arquivos/escopos: ${files}`,
    `dependências: ${deps}`,
    w.acceptance ? `aceite: ${w.acceptance}` : null,
    w.blocked_reason ? `bloqueio: ${w.blocked_reason}` : null,
    w.delivery_summary ? `entrega: ${w.delivery_summary}` : null,
    w.validation_summary ? `validação: ${w.validation_summary}` : null,
    w.worktree_path ? `worktree: ${w.worktree_path}` : null,
    w.integration_url ? `integração: ${w.integration_url}` : null,
    w.branch_name ? `branch: ${w.branch_name}` : null,
  ].filter(Boolean).join("\n");
}

function renderRecentChat(db: Database.Database, limit = 10, teamKey?: string | null): string {
  const rows = listChat(db, { limit, team_key: teamKey });
  if (!rows.length) return "Chat vazio.";
  const lines = ["ÚLTIMAS MENSAGENS:"];
  for (const r of rows.reverse()) lines.push(formatChatLine(r));
  return lines.join("\n");
}

function renderAgents(db: Database.Database, teamKey?: string | null): string {
  const agents = teamKey ? listAgentsForTeam(db, teamKey) : listAgents(db);
  if (!agents.length) return "Nenhum agente registrado.";
  const lines = ["AGENTES:"];
  for (const a of agents) {
    const session = a.current_session_id
      ? (db.prepare("SELECT name, status, last_heartbeat FROM sessions WHERE id = ?").get(a.current_session_id) as
          | { name: string; status: string; last_heartbeat: number }
          | undefined)
      : null;
    const sess = session ? `sessão=${session.name} (${session.status})` : "sessão=—";
    lines.push(`- ${a.name} [${a.role}] autoridade=${a.authority} status=${anotaSemNoticias(a.status, a.last_heartbeat)}  ${sess}`);
    if (a.folder) lines.push(`    pasta: ${a.folder}`);
  }
  return lines.join("\n");
}

interface OpenSessionInput {
  cargo: string;
  tarefa: string;
  projeto?: string | null;
  pasta?: string | null;
  areas?: string[];
  arquivos_pretendidos?: string[];
  agent?: AgentRow | null;
  teamKey?: string;
}

function openSession(db: Database.Database, p: OpenSessionInput): { sessionId: string; sessionName: string; taskId: string; ts: number } {
  const id = newId();
  const ts = now();
  const sessionStmt = db.prepare(
    `INSERT INTO sessions
     (id, name, role, task, project, folder, areas, intended_files, opened_at, last_heartbeat, status, agent_id, agent_name, team_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );

  // Race-safe: nome único pra sessão. Se outro processo inseriu mesmo nome
  // entre o pickSessionName e o INSERT, retry com próximo número.
  let name = pickSessionName(db, p.cargo);
  const taskId = newId();
  const tx = db.transaction(() => {
    let attempts = 0;
    while (true) {
      try {
        sessionStmt.run(
          id,
          name,
          p.cargo,
          p.tarefa,
          p.projeto ?? "",
          p.pasta ?? "",
          JSON.stringify(p.areas ?? []),
          JSON.stringify(p.arquivos_pretendidos ?? []),
          ts,
          ts,
          p.agent?.id ?? null,
          p.agent?.name ?? null,
          p.teamKey ?? p.agent?.team_key ?? deriveTeamKey(p.pasta, p.projeto)
        );
        break;
      } catch (e: any) {
        if (!/UNIQUE.*sessions\.name/i.test(e?.message ?? "") || attempts++ >= 10) throw e;
        name = pickSessionName(db, p.cargo);
      }
    }
    db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`
    ).run(taskId, id, p.tarefa, p.tarefa, ts, ts);

    if (p.agent) {
      const reserved = db.prepare(
        `UPDATE agents
         SET status = 'working', current_session_id = ?, current_task_id = ?, updated_at = ?, last_heartbeat = ?
         WHERE id = ? AND (status != 'working' OR current_session_id IS NULL)`
      ).run(id, taskId, ts, ts, p.agent.id);
      if (reserved.changes !== 1) {
        throw new Error(`Agente ${p.agent.name} já foi aberto por outra sessão.`);
      }
      touchAgent(db, p.agent.id);
    }
  });
  tx.immediate();
  return { sessionId: id, sessionName: name, taskId, ts };
}

// Ressuscita uma sessão dead (sem fechar e reabrir). Tudo numa transação
// IMMEDIATE com guardas: sem elas, duas janelas retomavam a MESMA sessão ao
// mesmo tempo, e uma janela podia sequestrar um agente que já trabalhava em
// outra sessão viva (current_session_id repontado por baixo da janela dona).
function reopenSession(
  db: Database.Database,
  sessionId: string,
  newTask: string,
  agent: AgentRow
): { sessionId: string; sessionName: string; taskId: string; ts: number } {
  const tx = db.transaction(() => {
    const ts = now();
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!session || session.closed_at || session.status === "closed") {
      throw new Error(`Sessão ${sessionId} não está mais disponível para retomada.`);
    }
    const st = deriveStatus(session);
    if (st === "active" || st === "suspect") {
      throw new Error(`Sessão ${session.name} já está ativa (outra janela retomou primeiro).`);
    }
    const atual = findAgentById(db, agent.id);
    if (atual?.current_session_id && atual.current_session_id !== sessionId) {
      const outra = db.prepare("SELECT * FROM sessions WHERE id = ?").get(atual.current_session_id) as SessionRow | undefined;
      if (outra && ["active", "suspect"].includes(deriveStatus(outra))) {
        throw new Error(
          `Agente ${agent.name} já está ativo em outra sessão (${outra.name}). Use aquela sessão ou feche-a antes.`
        );
      }
    }

    db.prepare(
      "UPDATE sessions SET last_heartbeat = ?, status = 'active', task = ? WHERE id = ?"
    ).run(ts, newTask, sessionId);

    // Reaproveita a task in_progress de mesmo título: cada restart criava uma
    // nova e, depois de alguns ciclos, marcar_feito falhava por ambiguidade.
    const existente = db.prepare(
      "SELECT id FROM tasks WHERE session_id = ? AND status = 'in_progress' AND title = ? ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId, newTask) as { id: string } | undefined;
    let taskId: string;
    if (existente) {
      taskId = existente.id;
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
    } else {
      taskId = newId();
      db.prepare(
        `INSERT INTO tasks (id, session_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`
      ).run(taskId, sessionId, newTask, newTask, ts, ts);
    }

    setAgentStatus(db, agent.id, "working", { current_session_id: sessionId, current_task_id: taskId });
    touchAgent(db, agent.id);

    return { sessionId, sessionName: session.name, taskId, ts };
  });
  return tx.immediate() as { sessionId: string; sessionName: string; taskId: string; ts: number };
}

function getAgentByActiveSession(db: Database.Database, sessionId: string): AgentRow | null {
  return getAgentForSession(db, sessionId);
}

function inboxRows(db: Database.Database, agent: AgentRow, since: number): { msgs: any[]; handoffs: any[] } {
  // Mensagens para este agente (por nome ou papel atual) + handoffs pendentes.
  const msgs = db
    .prepare(
      `SELECT cm.* FROM chat_messages cm
       WHERE cm.team_key = ? AND created_at > ?
         AND (
           to_target = ? OR to_target = ?
           OR (
             EXISTS (SELECT 1 FROM agents sender WHERE sender.id = cm.agent_id AND sender.authority = 'manager')
             AND (type = 'alerta' OR to_target IS NULL)
           )
           OR cm.role = 'dono' OR cm.session_id = 'desktop-owner'
           OR (? = 1 AND to_target IS NULL)
         )
       ORDER BY created_at ASC LIMIT 50`
    )
    .all(agent.team_key, since, agent.name, agent.role, isManagerAgent(agent) ? 1 : 0) as any[];

  const handoffs = db
    .prepare(
      `SELECT h.*, s.name as from_name FROM handoffs h
       LEFT JOIN sessions s ON s.id = h.from_session
       WHERE h.team_key = ? AND h.accepted = 0
         AND (h.to_target = ? OR h.to_target = ?)
       ORDER BY h.created_at ASC LIMIT 20`
    )
    .all(agent.team_key, agent.name, agent.role) as any[];

  return { msgs, handoffs };
}

function renderInbox(db: Database.Database, agent: AgentRow, since: number): string {
  const { msgs, handoffs } = inboxRows(db, agent, since);
  const lines: string[] = [];
  lines.push(`INBOX de ${agent.name} [${agent.role}] (desde ${new Date(since).toISOString().replace("T", " ").slice(0, 19)}):`);
  if (!msgs.length && !handoffs.length) {
    lines.push("  (vazio)");
    return lines.join("\n");
  }
  if (msgs.length) {
    lines.push("Mensagens direcionadas / alertas críticos:");
    for (const m of msgs) lines.push("  " + formatChatLine(m));
  }
  if (handoffs.length) {
    lines.push("Handoffs pendentes:");
    for (const h of handoffs) {
      const time = new Date(h.created_at).toISOString().replace("T", " ").slice(0, 19);
      lines.push(`  [${time}] de ${h.from_name ?? h.from_session} -> ${h.to_target}: ${h.note}`);
    }
  }
  return lines.join("\n");
}

// Entrada limpa por padrão: despejar inbox + time + work items + travas + chat
// em toda abertura enchia a janela nova com histórico velho da pasta (às vezes
// de semanas atrás) antes do agente fazer qualquer coisa. Agora a entrada só
// diz QUANTO existe; o conteúdo vem sob pedido (recuperar=true).
// Entrega com prova: 'validacao' é texto livre, então nada impedia entregar
// "rodei os testes" sem ter rodado nada. Quando o agente informa o comando, o
// próprio MCP executa (na worktree do item) e guarda o resultado junto da
// entrega. Falhou, não entrega.
function cauda(texto: string, linhas = 25): string {
  const todas = texto.trimEnd().split("\n");
  return todas.length <= linhas ? todas.join("\n") : ["...(saída cortada)", ...todas.slice(-linhas)].join("\n");
}

function rodarProva(comando: string, cwd: string, timeoutMs: number): { ok: boolean; resumo: string } {
  try {
    const saida = execSync(comando, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, resumo: `prova: ${comando} (exit 0) em ${cwd}\n${cauda(saida)}` };
  } catch (error: any) {
    const saida = [error?.stdout, error?.stderr].filter(Boolean).join("\n").toString();
    const motivo = error?.signal === "SIGTERM"
      ? `estourou ${Math.round(timeoutMs / 1000)}s`
      : `exit ${error?.status ?? "?"}`;
    return {
      ok: false,
      resumo: `prova: ${comando} (${motivo}) em ${cwd}\n${cauda(saida || String(error?.message ?? error))}`,
    };
  }
}

function renderResumoEntrada(db: Database.Database, teamKey: string, agent: AgentRow): string {
  const { msgs, handoffs } = inboxRows(db, agent, agent.last_seen_ms || agent.created_at);
  const abertos = listWorkItems(db, { limit: 100, team_key: teamKey })
    .filter((w) => !["done", "canceled"].includes(w.status)).length;
  const travas = activeLocks(db, 100, teamKey).length;
  const ultima = listChat(db, { limit: 1, team_key: teamKey })[0];
  const pendencias = msgs.length + handoffs.length;
  if (!pendencias && !abertos && !travas) return "contexto anterior: nada guardado nesta pasta.";
  return [
    `contexto anterior NÃO carregado (evita entrar com histórico velho):`,
    `  ${pendencias} no inbox · ${abertos} work item(s) aberto(s) · ${travas} trava(s)` +
      (ultima ? ` · última atividade da equipe há ${idadeHumana(ultima.created_at)}` : ""),
    `  quer retomar isso? reabra com recuperar=true (ou chame restaurar_contexto). Se for trabalho antigo, ignore e siga.`,
  ].join("\n");
}

function renderContextoEntrada(
  db: Database.Database,
  teamKey: string,
  agent: AgentRow,
  sessionId: string,
  arquivos: string[],
  areas: string[],
  recuperar: boolean
): string {
  const lines: string[] = [];
  if (arquivos.length) {
    const r = acquireLocks(db, sessionId, arquivos, areas[0], { id: agent.id, name: agent.name });
    if (r.granted.length) {
      lines.push(`travas concedidas na entrada: ${r.granted.map((g) => g.file).join(", ")}`);
    }
    for (const c of r.conflicts) {
      lines.push(`trava recusada: ${c.file} já está com ${c.held_by_name} [${c.held_by_role}] — NÃO edite antes de travar`);
    }
  }
  lines.push("");
  if (!recuperar) {
    lines.push(renderResumoEntrada(db, teamKey, agent));
    return lines.join("\n");
  }
  lines.push(renderInbox(db, agent, agent.last_seen_ms || agent.created_at));
  lines.push("");
  lines.push(renderTeamContext(db, teamKey));
  lines.push("");
  lines.push(renderWorkItems(db, teamKey));
  lines.push("");
  lines.push(renderLocks(db, teamKey));
  lines.push("");
  lines.push(renderRecentChat(db, 8, teamKey));
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────

export const tools: ToolDef[] = [
  {
    name: "abrir_sessao",
    description:
      "Compatibilidade: abre sessão informando papel e tarefa manualmente. Novos clientes devem usar abrir. Se já existir sessão viva com o mesmo cargo e tarefa na mesma equipe, recusa (force_new=true cria mesmo assim); se existir sessão morta, retoma em vez de duplicar.",
    inputSchema: {
      type: "object",
      properties: {
        cargo: { type: "string", description: "Papel desta sessão (legado; no fluxo novo o gerente atribui)." },
        tarefa: { type: "string", description: "Tarefa principal desta sessão." },
        projeto: { type: "string", description: "Nome do projeto." },
        pasta: { type: "string", description: "Pasta de trabalho atual (absoluta)." },
        areas: {
          type: "array",
          items: { type: "string" },
          description: "Áreas/módulos que pretende mexer (ex: 'bot/leads', 'crm/ui').",
        },
        arquivos_pretendidos: {
          type: "array",
          items: { type: "string" },
          description: "Lista de arquivos que pretende editar (paths).",
        },
        force_new: {
          type: "boolean",
          default: false,
          description: "Cria um segundo agente mesmo já havendo sessão viva com o mesmo cargo e tarefa.",
        },
      },
      required: ["cargo", "tarefa"],
    },
    handler: (args) => {
      const schema = z.object({
        cargo: z.string().min(1),
        tarefa: z.string().min(1),
        projeto: z.string().optional().default(""),
        pasta: z.string().optional().default(""),
        areas: z.array(z.string()).optional().default([]),
        arquivos_pretendidos: z.array(z.string()).optional().default([]),
        force_new: z.boolean().optional().default(false),
      });
      const p = schema.parse(args);
      const db = getDb();
      sweepSessions(db);

      // Sem pasta explícita, herda do ambiente. Sem isso, sessões de projetos
      // diferentes caíam todas na equipe 'default' e o chat vinha misturado.
      const pastaEfetiva = p.pasta || process.env.AGENTDESK_FOLDER || process.cwd();

      // Proteção contra duplicata: na operação real, o retry do cliente após
      // um falso-morto criava dois agentes com o mesmo cargo e a mesma tarefa
      // ("um morto e um trabalhando"). Sessão viva igual recusa; morta retoma.
      // Decisão E criação na MESMA transação IMMEDIATE: sem isso, duas janelas
      // simultâneas passavam ambas pelo SELECT antes de qualquer INSERT e a
      // duplicata voltava pela porta da corrida.
      const dedupTeamKey = deriveTeamKey(pastaEfetiva, p.projeto);
      type Abertura =
        | { tipo: "retomada"; dono: AgentRow; reaberta: { sessionId: string; sessionName: string; taskId: string; ts: number } }
        | { tipo: "nova"; agent: AgentRow; opened: { sessionId: string; sessionName: string; taskId: string; ts: number } };
      const abertura = db.transaction((): Abertura => {
        if (!p.force_new) {
          const iguais = db.prepare(
            `SELECT * FROM sessions
             WHERE team_key = ? AND role = ? AND task = ? AND status != 'closed' AND closed_at IS NULL
             ORDER BY last_heartbeat DESC`
          ).all(dedupTeamKey, p.cargo, p.tarefa) as SessionRow[];
          for (const existente of iguais) {
            const st = deriveStatus(existente);
            if (st === "active" || st === "suspect") {
              const quem = existente.agent_name || existente.name;
              throw new Error(
                `Já existe ${quem} trabalhando nesta mesma tarefa (sessão ${existente.name}, ` +
                  `session_id=${existente.id}, status=${st}). Para continuar aquele trabalho, ` +
                  `use abrir com retomar_agente_id; para criar mesmo assim um segundo agente, ` +
                  `re-chame com force_new=true.`
              );
            }
            if (st === "dead" && existente.agent_id) {
              const dono = findAgentById(db, existente.agent_id);
              if (dono && dono.status !== "archived") {
                return { tipo: "retomada", dono, reaberta: reopenSession(db, existente.id, p.tarefa, dono) };
              }
            }
          }
        }
        // Legacy: cria agente novo. Pra retomada por nome use abrir_ou_retornar_agente.
        const novoAgente = createAgent(db, {
          name: pickUniqueName(db),
          role: p.cargo,
          project: p.projeto,
          folder: pastaEfetiva,
          tmux_pane: envTmuxPane(),
        });
        const opened = openSession(db, {
          cargo: p.cargo,
          tarefa: p.tarefa,
          projeto: p.projeto,
          pasta: pastaEfetiva,
          areas: p.areas,
          arquivos_pretendidos: p.arquivos_pretendidos,
          agent: novoAgente,
        });
        return { tipo: "nova", agent: novoAgente, opened };
      }).immediate() as Abertura;

      if (abertura.tipo === "retomada") {
        const { dono, reaberta } = abertura;
        recordEvent(db, reaberta.sessionId, "session.reopened_dedup", {
          agent_id: dono.id,
          role: p.cargo,
          task: p.tarefa,
        });
        postChat(db, {
          sessionId: reaberta.sessionId,
          sessionName: reaberta.sessionName,
          role: p.cargo,
          type: "falar",
          agentId: dono.id,
          agentName: dono.name,
          message: `Voltei. Retomando a mesma tarefa: ${p.tarefa}.`,
        });
        return text(
          [
            `Sessão retomada (não duplicada): ${reaberta.sessionName} (id=${reaberta.sessionId})`,
            `Agente: ${dono.name} [id=${dono.id}]`,
            `Papel: ${p.cargo}`,
            `Tarefa: ${p.tarefa}`,
            `Tarefa principal (task_id): ${reaberta.taskId}`,
            "",
            "Havia uma sessão sem notícias com este mesmo cargo e tarefa; ela foi reaproveitada.",
            "Guarde session_id, agent_id e task_id para usar nos próximos comandos.",
          ].join("\n")
        );
      }

      const { agent, opened } = abertura;
      const { sessionId, sessionName, taskId } = opened;

      recordEvent(db, sessionId, "session.opened", { name: sessionName, role: p.cargo, task: p.tarefa, agent: agent.name });
      postChat(db, {
        sessionId,
        sessionName,
        role: p.cargo,
        type: "falar",
        agentId: agent.id,
        agentName: agent.name,
        message: `Entrei na equipe. Tarefa: ${p.tarefa}${p.projeto ? ` (projeto ${p.projeto})` : ""}.`,
      });

      const ctx = renderTeamContext(db);
      const locks = renderLocks(db);
      const chat = renderRecentChat(db, 8);

      return text(
        [
          `Sessão aberta: ${sessionName} (id=${sessionId})`,
          `Agente: ${agent.name} [id=${agent.id}]`,
          `Papel: ${p.cargo}`,
          `Tarefa: ${p.tarefa}`,
          `Pasta: ${pastaEfetiva}`,
          `Tarefa principal (task_id): ${taskId}`,
          "",
          "Guarde session_id, agent_id e task_id para usar nos próximos comandos.",
          "",
          "── CONTEXTO DO TIME ──",
          ctx,
          "",
          locks,
          "",
          chat,
        ].join("\n")
      );
    },
  },

  {
    name: "listar_status",
    description:
      "Mostra a equipe ativa, status (active/suspect/dead), travas de arquivo, tarefas em aberto e últimas mensagens. Filtra pela equipe do chamador por padrão; todas_equipes=true mostra tudo.",
    inputSchema: {
      type: "object",
      properties: { ...ESCOPO_PROPS },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const teamKey = resolveTeamScope(db, args);
      const out = [
        cabecalhoEscopo(teamKey),
        "",
        renderAgents(db, teamKey),
        "",
        renderTeamContext(db, teamKey),
        "",
        renderWorkItems(db, teamKey),
        "",
        renderLocks(db, teamKey),
        "",
        renderTasks(db, teamKey),
        "",
        renderRecentChat(db, 12, teamKey),
      ].join("\n");
      return text(out);
    },
  },

  {
    name: "enviar_mensagem",
    description:
      "Envia uma mensagem para o chat geral da equipe (tipo 'falar'). Use para registrar decisões, avisos curtos ou status para todo mundo ver.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        mensagem: { type: "string" },
        arquivos: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "mensagem"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      if (ag) touchAgent(db, ag.id);
      const row = postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "falar",
        message: args.mensagem,
        files: args.arquivos,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "chat.falar", { id: row.id });
      return text(`Mensagem registrada.\n${formatChatLine(row)}`);
    },
  },

  {
    name: "pedir_acao",
    description:
      "Pede uma ação a outro agente ou a quem estiver num papel atual específico.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        destinatario: {
          type: "string",
          description: "Nome do agente/sessão ou papel atual livre.",
        },
        mensagem: { type: "string" },
        arquivos: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "destinatario", "mensagem"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      if (ag) touchAgent(db, ag.id);
      const row = postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "pedir",
        to: args.destinatario,
        message: args.mensagem,
        files: args.arquivos,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "chat.pedir", { id: row.id, to: args.destinatario });
      return text(`Pedido registrado.\n${formatChatLine(row)}`);
    },
  },

  {
    name: "passar_tarefa",
    description:
      "Passa (handoff) uma tarefa para outro agente ou papel atual. Registra a transferência e libera as travas.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task_id: { type: "string", description: "ID da tarefa a passar (opcional: usa a principal se omitido)." },
        destinatario: { type: "string", description: "Nome do agente/sessão ou papel atual de destino." },
        nota: { type: "string", description: "Contexto curto para quem vai assumir." },
        liberar_travas: { type: "boolean", default: true },
      },
      required: ["session_id", "destinatario", "nota"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      if (ag) touchAgent(db, ag.id);

      let taskId: string | undefined = args.task_id;
      if (!taskId && ag?.current_task_id) {
        const cur = db.prepare("SELECT id, status FROM tasks WHERE id = ?")
          .get(ag.current_task_id) as { id: string; status: string } | undefined;
        if (cur && cur.status === "in_progress") taskId = cur.id;
      }
      if (!taskId) {
        const rows = db.prepare(
          "SELECT id FROM tasks WHERE session_id = ? AND status = 'in_progress' ORDER BY created_at ASC"
        ).all(s.id) as { id: string }[];
        if (rows.length > 1) {
          throw new Error(
            `Tem ${rows.length} tarefas em andamento — passe task_id explicitamente.`
          );
        }
        taskId = rows[0]?.id;
      }

      if (!taskId) throw new Error("Nenhuma tarefa em andamento para passar.");

      // Handoff com contexto: quem recebe precisa saber o que já foi decidido
      // e tentado, não só a nota. Sem isso o destinatário recebia o título e
      // recomeçava do zero, repetindo caminhos que já falharam.
      const tarefaPassada = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as
        | { title: string }
        | undefined;
      const historico = db.prepare(
        `SELECT progress, created_at FROM updates
         WHERE session_id = ? OR task_id = ?
         ORDER BY created_at DESC LIMIT 5`
      ).all(s.id, taskId) as Array<{ progress: string; created_at: number }>;
      // Limites duros: um trabalhador verboso não pode explodir o inbox de
      // quem recebe (a nota inteira é impressa no inbox e no tick detalhado).
      const resumir = (texto: string, max: number) =>
        texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
      let notaCompleta = [
        args.nota,
        tarefaPassada ? `Tarefa: ${tarefaPassada.title}` : null,
        ...(historico.length
          ? [
              "O que já foi feito/decidido (mais recente primeiro):",
              ...historico.map((u) => {
                const quando = new Date(u.created_at).toISOString().replace("T", " ").slice(0, 16);
                return `  - [${quando}] ${resumir(u.progress, 300)}`;
              }),
            ]
          : []),
      ].filter(Boolean).join("\n");
      notaCompleta = resumir(notaCompleta, 4000);

      const ts = now();
      const hid = newId();
      db.prepare(
        "INSERT INTO handoffs (id, from_session, to_target, task_id, note, created_at, accepted, team_key) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
      ).run(hid, s.id, args.destinatario, taskId, notaCompleta, ts, teamKeyForSession(s, ag));
      notify({
        kind: "handoff",
        to: args.destinatario,
        team_key: teamKeyForSession(s, ag),
        from_agent_id: ag?.id ?? null,
        urgent: true,
      });
      db.prepare("UPDATE tasks SET status = 'handed_off', updated_at = ? WHERE id = ?").run(ts, taskId);

      const liberar = args.liberar_travas !== false;
      let releasedCount = 0;
      if (liberar) {
        const r = releaseLocks(db, s.id);
        releasedCount = r.released.length;
      }

      const row = postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "passar",
        to: args.destinatario,
        taskId,
        message: `Passando tarefa${tarefaPassada ? ` "${tarefaPassada.title}"` : ""}: ${args.nota}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "task.handoff", { task_id: taskId, to: args.destinatario, released: releasedCount });

      return text(
        `Tarefa ${taskId} passada para ${args.destinatario}. Travas liberadas: ${releasedCount}.\n${formatChatLine(row)}`
      );
    },
  },

  {
    name: "travar_arquivos",
    description:
      "Tenta travar arquivos antes de editar. Lock forte por arquivo + aviso por área. Se conflitar com sessão ativa, recusa e mostra quem está usando.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        arquivos: { type: "array", items: { type: "string" }, description: "Paths absolutos preferencialmente." },
        area: { type: "string", description: "Nome da área/módulo (opcional)." },
      },
      required: ["session_id", "arquivos"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      if (ag) touchAgent(db, ag.id);

      const r = acquireLocks(db, s.id, args.arquivos, args.area, ag ? { id: ag.id, name: ag.name } : null);
      recordEvent(db, s.id, "locks.acquire", r);

      const lines: string[] = [];
      if (r.granted.length) {
        lines.push("Travado com sucesso:");
        for (const g of r.granted) lines.push(`  ✓ ${g.file}`);
      }
      if (r.conflicts.length) {
        lines.push("Conflitos — NÃO edite estes arquivos:");
        for (const c of r.conflicts)
          lines.push(`  ✗ ${c.file}  ← ${c.held_by_name} [${c.held_by_role}] (status ${c.status})`);
        postChat(db, {
          sessionId: s.id,
          sessionName: s.name,
          role: s.role,
          type: "alerta",
          message: `Tentei travar ${r.conflicts.map((c) => c.file).join(", ")} mas há conflito com outra sessão.`,
          agentId: ag?.id ?? null,
          agentName: ag?.name ?? null,
        });
      }
      if (r.warnings.length) {
        lines.push("Avisos de área (outras sessões mexendo perto):");
        for (const w of r.warnings) {
          for (const o of w.other_sessions) {
            lines.push(`  ! área ${w.area}: ${o.name} [${o.role}] em ${o.files.join(", ")}`);
          }
        }
      }
      if (!lines.length) lines.push("Nada para travar.");
      return text(lines.join("\n"));
    },
  },

  {
    name: "liberar_trava",
    description:
      "Libera travas. Sem 'arquivos', libera todas as suas. Com 'forcar=true', somente a autoridade do gerente força outra trava.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        arquivos: { type: "array", items: { type: "string" } },
        forcar: { type: "boolean", default: false },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      const caller = getAgentByActiveSession(db, s.id);
      const r = releaseLocks(db, s.id, args.arquivos, args.forcar, isManagerAgent(caller) ? MANAGER_ROLE : s.role);
      recordEvent(db, s.id, "locks.release", { files: r.released, forced: !!args.forcar });
      return text(`Liberadas ${r.released.length} travas:\n${r.released.map((f) => `  - ${f}`).join("\n") || "  (nenhuma)"}`);
    },
  },

  {
    name: "atualizar_progresso",
    description:
      "Registra um progresso curto da sessão (1-3 linhas). Aparece no contexto da equipe e atualiza o heartbeat.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        progresso: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["session_id", "progresso"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const ts = now();
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(ts, s.id);
      if (ag) {
        touchAgent(db, ag.id);
        // Mantém resumo persistente — usado por /restaurarcontexto após restart.
        const timestamp = new Date(ts).toISOString().replace("T", " ").slice(0, 19);
        db.prepare("UPDATE agents SET progress_summary = ? WHERE id = ?").run(
          `[${timestamp}] ${args.progresso}`,
          ag.id
        );
      }
      db.prepare(
        "INSERT INTO updates (id, session_id, task_id, progress, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(newId(), s.id, args.task_id ?? null, args.progresso, ts);
      if (args.task_id) {
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, args.task_id);
      }
      recordEvent(db, s.id, "task.update", { progress: args.progresso });
      return text(`Progresso registrado: ${args.progresso}`);
    },
  },

  {
    name: "marcar_feito",
    description:
      "Marca uma tarefa como concluída. Libera as travas associadas a essa sessão (a menos que 'manter_travas=true').",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task_id: { type: "string" },
        resumo: { type: "string", description: "Resumo curto do que foi entregue." },
        manter_travas: { type: "boolean", default: false },
      },
      required: ["session_id", "resumo"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const ts = now();
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(ts, s.id);
      if (ag) touchAgent(db, ag.id);

      // Prioridade pra resolver task_id: 1) arg explícito; 2) current_task_id
      // do agente (a tarefa "principal" linkada ao agente); 3) só então
      // fallback pela 1ª task in_progress da sessão. Antes ia direto pro
      // fallback — agente com 2+ tasks marcava errada.
      let taskId: string | undefined = args.task_id;
      if (!taskId && ag?.current_task_id) {
        const cur = db
          .prepare("SELECT id, status FROM tasks WHERE id = ?")
          .get(ag.current_task_id) as { id: string; status: string } | undefined;
        if (cur && cur.status === "in_progress") taskId = cur.id;
      }
      if (!taskId) {
        const rows = db
          .prepare(
            "SELECT id FROM tasks WHERE session_id = ? AND status = 'in_progress' ORDER BY created_at ASC"
          )
          .all(s.id) as { id: string }[];
        if (rows.length > 1) {
          throw new Error(
            `Tem ${rows.length} tarefas em andamento nesta sessão (${rows.map((r) => r.id).join(", ")}). ` +
              `Passe task_id explicitamente pra evitar marcar a errada.`
          );
        }
        taskId = rows[0]?.id;
      }

      if (!taskId) throw new Error("Nenhuma tarefa em andamento para marcar como feita.");

      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(ts, taskId);

      let released: string[] = [];
      if (!args.manter_travas) {
        released = releaseLocks(db, s.id).released;
      }

      const row = postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "decisao",
        taskId,
        message: `Feito: ${args.resumo}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "task.done", { task_id: taskId, released: released.length });

      return text(
        `Tarefa ${taskId} concluída. Travas liberadas: ${released.length}.\n${formatChatLine(row)}`
      );
    },
  },

  {
    name: "fechar_sessao",
    description:
      "Encerra a sessão corretamente: libera travas, marca tarefas em andamento como pending e registra evento.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        motivo: { type: "string" },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const ts = now();
      // Tudo numa transação: se crashar no meio, ou tudo aplica ou nada.
      // Antes: releaseLocks + UPDATE tasks + UPDATE sessions + setAgentStatus
      // em 4 statements separados → se processo morresse, locks zumbis ou
      // tasks órfãs.
      let released: string[] = [];
      const tx = db.transaction(() => {
        released = releaseLocks(db, s.id).released;
        db.prepare(
          "UPDATE tasks SET status = 'pending', updated_at = ? WHERE session_id = ? AND status = 'in_progress'"
        ).run(ts, s.id);
        db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(ts, s.id);
        if (ag) {
          setAgentStatus(db, ag.id, "paused", { current_session_id: null, current_task_id: null });
        }
      });
      tx.immediate();

      // Chat e event ficam fora da transação — não bloqueiam fechamento se falharem.
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "falar",
        message: `Saindo. ${args.motivo ?? ""}`.trim(),
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "session.closed", { released: released.length, motivo: args.motivo ?? null, agent: ag?.name ?? null });
      return text(
        `Sessão ${s.name} fechada. ${released.length} travas liberadas.` +
          (ag ? ` Agente ${ag.name} agora está em status 'paused' — pode ser retomado depois com /abrir.` : "")
      );
    },
  },

  {
    name: "heartbeat",
    description:
      "Atualiza last_heartbeat da sessão. Chamar pelo menos a cada ~30 segundos durante o trabalho.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      if (ag) touchAgent(db, ag.id);
      return text(`ok ${ag ? ag.name : s.name}`);
    },
  },

  {
    name: "listar_chat",
    description:
      "Lista mensagens recentes do chat da equipe do chamador (todas_equipes=true para o chat global). Pode filtrar por destinatário, tipo, e quantidade.",
    inputSchema: {
      type: "object",
      properties: {
        limite: { type: "number", default: 30 },
        para: { type: "string", description: "Filtra por destinatário (nome ou papel atual)." },
        tipo: { type: "string", enum: ["falar", "pedir", "passar", "alerta", "decisao", "erro"] },
        desde_ts: { type: "number", description: "timestamp ms para filtrar mensagens posteriores." },
        ...ESCOPO_PROPS,
      },
    },
    handler: (args) => {
      const db = getDb();
      const teamKey = resolveTeamScope(db, args);
      const rows = listChat(db, {
        limit: args?.limite ?? 30,
        to: args?.para ?? null,
        type: args?.tipo as ChatType | undefined,
        since: args?.desde_ts,
        team_key: teamKey,
      });
      if (!rows.length) return text(`Sem mensagens. ${cabecalhoEscopo(teamKey)}`);
      return text([cabecalhoEscopo(teamKey), ...rows.reverse().map(formatChatLine)].join("\n"));
    },
  },

  {
    name: "listar_contexto_time",
    description:
      "Retorna o snapshot completo do contexto da equipe do chamador: sessões ativas, tarefas, travas, últimas decisões e progresso. todas_equipes=true para a visão global.",
    inputSchema: {
      type: "object",
      properties: { ...ESCOPO_PROPS },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const teamKey = resolveTeamScope(db, args);

      const recentDecisions = db
        .prepare(
          "SELECT * FROM chat_messages WHERE type IN ('decisao','alerta') AND (? IS NULL OR team_key = ?) ORDER BY created_at DESC LIMIT 10"
        )
        .all(teamKey, teamKey) as any[];
      const lastUpdates = db
        .prepare(
          `SELECT u.*, s.name as session_name, s.role as session_role
           FROM updates u JOIN sessions s ON s.id = u.session_id
           WHERE (? IS NULL OR s.team_key = ?)
           ORDER BY u.created_at DESC LIMIT 10`
        )
        .all(teamKey, teamKey) as any[];

      const out: string[] = [];
      out.push(cabecalhoEscopo(teamKey));
      out.push("");
      out.push(renderAgents(db, teamKey));
      out.push("");
      out.push(renderTeamContext(db, teamKey));
      out.push("");
      out.push(renderTasks(db, teamKey));
      out.push("");
      out.push(renderWorkItems(db, teamKey));
      out.push("");
      out.push(renderLocks(db, teamKey));
      out.push("");
      out.push("ÚLTIMAS DECISÕES/ALERTAS:");
      if (!recentDecisions.length) out.push("  (nenhuma)");
      for (const d of recentDecisions.reverse()) out.push("  " + formatChatLine(d));
      out.push("");
      out.push("ÚLTIMOS PROGRESSOS:");
      if (!lastUpdates.length) out.push("  (nenhum)");
      for (const u of lastUpdates.reverse()) {
        const time = new Date(u.created_at).toISOString().replace("T", " ").slice(0, 19);
        out.push(`  [${time}] ${u.session_name} [${u.session_role}]: ${u.progress}`);
      }
      out.push("");
      out.push(renderRecentChat(db, 15, teamKey));

      return text(out.join("\n"));
    },
  },

  {
    name: "relatorio_equipe",
    description:
      "Mede a produção real da equipe no período: tarefas entregues e concluídas, tempo por tarefa, espera na fila e na revisão, retrabalho, tarefas devolvidas por janela que sumiu, quanto o paralelismo rendeu contra fazer tudo em série e quantas entregas tiveram prova executada.",
    inputSchema: {
      type: "object",
      properties: {
        dias: { type: "number", default: 7, description: "Janela de análise em dias (1 a 90)." },
        ...ESCOPO_PROPS,
      },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const teamKey = resolveTeamScope(db, args);
      const dias = Math.min(Math.max(Math.round(Number(args?.dias ?? 7)), 1), 90);
      const desde = now() - dias * 24 * 60 * 60 * 1000;

      const itens = db
        .prepare(
          `SELECT * FROM work_items
            WHERE (? IS NULL OR team_key = ?)
              AND (created_at >= ? OR COALESCE(claimed_at, 0) >= ? OR COALESCE(delivered_at, 0) >= ? OR COALESCE(reviewed_at, 0) >= ?)`
        )
        .all(teamKey, teamKey, desde, desde, desde, desde) as WorkItemRow[];

      const criadas = itens.filter((i) => i.created_at >= desde);
      const entregues = itens.filter((i) => i.delivered_at && i.delivered_at >= desde && i.claimed_at);
      const concluidas = itens.filter((i) => i.status === "done" && i.reviewed_at && i.reviewed_at >= desde);
      const reprovadas = itens.filter((i) => i.status === "blocked" && i.reviewed_at && i.reviewed_at >= desde);

      const ciclo = entregues.map((i) => i.delivered_at! - i.claimed_at!).filter((v) => v >= 0);
      const fila = itens
        .filter((i) => i.claimed_at && i.claimed_at >= desde)
        .map((i) => i.claimed_at! - i.created_at)
        .filter((v) => v >= 0);
      const revisao = itens
        .filter((i) => i.reviewed_at && i.reviewed_at >= desde && i.delivered_at)
        .map((i) => i.reviewed_at! - i.delivered_at!)
        .filter((v) => v >= 0);

      // Ganho do paralelismo: soma do tempo trabalhado dividida pelo tempo de
      // relógio em que pelo menos uma tarefa esteve em execução. É a medida
      // honesta de "quantas vezes mais rápido que fazer uma de cada vez".
      const intervalos = entregues.map((i) => [i.claimed_at!, i.delivered_at!] as [number, number]);
      const somaTrabalho = intervalos.reduce((total, [a, b]) => total + Math.max(0, b - a), 0);
      const relogio = uniaoMs(intervalos);
      const ganho = relogio > 0 ? somaTrabalho / relogio : 0;

      const comProva = entregues.filter((i) => /\(exit 0\)/.test(i.validation_summary ?? "")).length;
      const semProva = entregues.filter((i) => /prova: nenhuma/.test(i.validation_summary ?? "")).length;

      const devolvidas = (db
        .prepare(
          `SELECT count(*) AS n FROM events e
             LEFT JOIN sessions s ON s.id = e.session_id
            WHERE e.type = 'work_item.requeued' AND e.created_at >= ?
              AND (? IS NULL OR s.team_key = ?)`
        )
        .get(desde, teamKey, teamKey) as { n: number }).n;

      const porAgente = new Map<string, number[]>();
      for (const item of entregues) {
        const nome = item.owner_agent_name ?? "—";
        const lista = porAgente.get(nome) ?? [];
        lista.push(item.delivered_at! - item.claimed_at!);
        porAgente.set(nome, lista);
      }

      const out: string[] = [];
      out.push(`${cabecalhoEscopo(teamKey)}  ·  últimos ${dias} dia(s)`);
      out.push("");
      if (!entregues.length && !criadas.length) {
        out.push("Nenhuma tarefa criada ou entregue no período. Nada para medir ainda.");
        return text(out.join("\n"));
      }
      out.push(
        `criadas: ${criadas.length} · entregues: ${entregues.length} · concluídas: ${concluidas.length} · ` +
          `reprovadas na revisão: ${reprovadas.length} · devolvidas por janela que sumiu: ${devolvidas}`
      );
      if (ciclo.length) {
        out.push(`tempo por tarefa (assumir até entregar): mediana ${dur(quantil(ciclo, 0.5))}, pior 10% ${dur(quantil(ciclo, 0.9))}`);
      }
      if (fila.length) out.push(`espera na fila (criada até assumida): mediana ${dur(quantil(fila, 0.5))}`);
      if (revisao.length) out.push(`espera na revisão (entregue até revisada): mediana ${dur(quantil(revisao, 0.5))}`);
      if (relogio > 0) {
        out.push(
          `paralelismo: ${ganho.toFixed(1)}x contra fazer uma de cada vez ` +
            `(${dur(somaTrabalho)} de trabalho somado em ${dur(relogio)} de relógio)`
        );
      }
      if (entregues.length) {
        const pct = Math.round((comProva / entregues.length) * 100);
        out.push(`entregas com prova executada: ${comProva} de ${entregues.length} (${pct}%)${semProva ? `, ${semProva} só com relato` : ""}`);
      }
      if (porAgente.size) {
        const linhas = [...porAgente.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([nome, tempos]) => `${nome} ${tempos.length} (mediana ${dur(quantil(tempos, 0.5))})`);
        out.push(`por agente: ${linhas.join(" · ")}`);
      }
      if (dias > 7) {
        out.push("");
        out.push("nota: 'devolvidas por janela que sumiu' vem do log de eventos, que é apagado após 7 dias; períodos maiores contam menos que o real.");
      }
      return text(out.join("\n"));
    },
  },

  {
    name: "detectar_conflitos",
    description:
      "Dado um conjunto de arquivos que você pretende editar, retorna se há conflitos com travas de outras sessões ativas. Não cria trava — só checa.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        arquivos: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "arquivos"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      sweepSessions(db);
      // Atualiza heartbeat para não ser marcado dead enquanto detecta conflitos.
      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      const conflicts = detectConflicts(db, s.id, args.arquivos);
      if (!conflicts.length) return text("Sem conflitos. Pode prosseguir e travar.");
      const lines = ["Conflitos detectados:"];
      for (const c of conflicts) lines.push(`  ✗ ${c.file}  ← ${c.held_by_name} [${c.held_by_role}] (${c.status})`);
      return text(lines.join("\n"));
    },
  },

  // ─── Agentes persistentes ─────────────────────────────────────────────────

  {
    name: "abrir",
    description:
      "Entrada única da equipe. Não recebe cargo: elege um único gerente por pasta/equipe, abre ou retoma a identidade, liga o modo auto e, para trabalhadores, já assume o próximo work item pronto. Depois desta chamada siga o próximo_passo retornado sem pedir decisões reversíveis ao gerente.",
    inputSchema: {
      type: "object",
      properties: {
        projeto: { type: "string", description: "Nome opcional do projeto." },
        pasta: { type: "string", description: "Pasta da equipe; usa AGENTDESK_FOLDER se omitida." },
        preferred_name: { type: "string", description: "Nome desejado; retoma se existir ou usa ao criar." },
        retomar_agente_id: { type: "string", description: "Opcional para retomar uma identidade conhecida." },
        force_new: { type: "boolean", default: false, description: "Cria novo trabalhador; nunca cria um segundo gerente." },
        recuperar: {
          type: "boolean",
          default: false,
          description:
            "Padrão false: entra limpo e só informa quanto contexto existe guardado. true carrega o histórico completo (inbox, time, work items, travas, chat). Só peça true quando o trabalho anterior desta pasta for mesmo a continuação.",
        },
        tmux_pane: { type: "string", description: "Pane tmux atual, para push do loop auto." },
        areas: { type: "array", items: { type: "string" }, description: "Áreas/módulos que pretende mexer." },
        arquivos_pretendidos: {
          type: "array",
          items: { type: "string" },
          description: "Arquivos fora do escopo do work item que devem ser travados já na entrada.",
        },
      },
    },
    handler: (args) => {
      const p = z.object({
        projeto: z.string().optional().default(""),
        pasta: z.string().optional().default(""),
        preferred_name: z.string().optional(),
        retomar_agente_id: z.string().optional(),
        force_new: z.boolean().optional().default(false),
        recuperar: z.boolean().optional().default(false),
        tmux_pane: z.string().optional(),
        areas: z.array(z.string()).optional().default([]),
        arquivos_pretendidos: z.array(z.string()).optional().default([]),
      }).parse(args ?? {});

      const db = getDb();
      sweepSessions(db);
      // Sem pasta explícita, herda do ambiente (evita o balde 'default').
      const folder = p.pasta || process.env.AGENTDESK_FOLDER || process.cwd();
      const teamKey = deriveTeamKey(folder, p.projeto);
      const pane = p.tmux_pane || envTmuxPane();
      let agent: AgentRow | null = null;
      let mode: "created" | "resumed" | "already_open" = "created";

      if (p.retomar_agente_id) {
        agent = findAgentById(db, p.retomar_agente_id);
        if (!agent || agent.status === "archived") throw new Error("A identidade pedida não existe ou está arquivada.");
      } else if (p.preferred_name) {
        agent = findAgentByName(db, p.preferred_name);
        if (agent?.status === "archived") throw new Error("A identidade pedida está arquivada.");
      }
      if (agent) {
        if (agent.team_key !== teamKey) {
          throw new Error(`O agente ${agent.name} pertence a outra equipe (${agent.team_key}).`);
        }
        mode = "resumed";
      }

      let manager = findManagerForTeam(db, teamKey);
      let lostManagerElection = false;
      if (!agent && !manager) {
        const elected = createOrGetManager(db, {
          name: p.preferred_name && !findAgentByName(db, p.preferred_name)
            ? p.preferred_name
            : pickUniqueName(db),
          role: MANAGER_ROLE,
          team_key: teamKey,
          project: p.projeto,
          folder,
          tmux_pane: pane,
        });
        manager = elected.agent;
        if (elected.created) {
          agent = elected.agent;
          mode = "created";
        } else {
          // Outra janela venceu a eleição enquanto esta aguardava o write
          // lock. Esta janela vira capacidade de trabalho, não uma segunda
          // sessão apontando para a mesma identidade de gerente.
          lostManagerElection = true;
        }
      }

      if (!agent && manager && !p.force_new) {
        // Identidade da própria pane é a retomada mais confiável.
        if (pane) {
          agent = (db.prepare(
            `SELECT * FROM agents
             WHERE team_key = ? AND tmux_pane = ? AND status != 'archived'
             ORDER BY updated_at DESC LIMIT 1`
          ).get(teamKey, pane) as AgentRow | undefined) ?? null;
        }

        // Se o gerente ainda não está rodando, a primeira janela que volta
        // retoma a coordenação. As próximas janelas pegam trabalhadores.
        if (!agent && !lostManagerElection && ["paused", "dead"].includes(manager.status)) agent = manager;

        if (!agent) {
          agent = (db.prepare(
            `SELECT * FROM agents
             WHERE team_key = ? AND authority = 'worker'
               AND status IN ('available','paused','dead')
             ORDER BY CASE status WHEN 'paused' THEN 0 WHEN 'dead' THEN 1 ELSE 2 END,
                      updated_at DESC
             LIMIT 1`
          ).get(teamKey) as AgentRow | undefined) ?? null;
        }
        if (agent) mode = "resumed";
      }

      if (!agent) {
        const requestedName = p.preferred_name && !findAgentByName(db, p.preferred_name)
          ? p.preferred_name
          : pickUniqueName(db);
        agent = createAgent(db, {
          name: requestedName,
          role: AVAILABLE_ROLE,
          authority: "worker",
          team_key: teamKey,
          project: p.projeto,
          folder,
          tmux_pane: pane,
        });
        mode = "created";
      }

      // Repetir /abrir na mesma janela é idempotente.
      if (agent.current_session_id) {
        const live = db.prepare("SELECT * FROM sessions WHERE id = ?")
          .get(agent.current_session_id) as SessionRow | undefined;
        if (live && ["active", "suspect"].includes(deriveStatus(live))) {
          if (pane) db.prepare("UPDATE agents SET tmux_pane = ? WHERE id = ?").run(pane, agent.id);
          setAgentAutoMode(db, agent.id, true, pane);
          const claimed = autoClaimNext(db, live, agent);
          mode = "already_open";
          return text([
            `ABERTO · ${agent.name}/${agent.role}`,
            `agent_id: ${agent.id}`,
            `session_id: ${live.id}`,
            `team_key: ${teamKey}`,
            `autoridade: ${isManagerAgent(agent) ? "gerente" : "trabalhador"}`,
            "auto_mode: ATIVO",
            claimed ? `work_item: ${claimed.id} · ${claimed.title}` : "work_item: nenhum pronto",
            isManagerAgent(agent)
              ? "proximo_passo: receba a lista do usuário e chame distribuir_tarefas uma vez."
              : claimed
                ? "proximo_passo: execute agora; decida sozinho tudo que for reversível e entregue ao validar."
                : "proximo_passo: chame tick_autonomo compacto; a fila será assumida automaticamente quando houver item pronto.",
            renderContextoEntrada(db, teamKey, agent, live.id, p.arquivos_pretendidos, p.areas, p.recuperar),
          ].join("\n"));
        }
      }

      const initialTask = isManagerAgent(agent)
        ? "Coordenar a fila da equipe"
        : "Assumir o próximo item pronto";
      const opened = openSession(db, {
        cargo: agent.role,
        tarefa: initialTask,
        projeto: p.projeto || agent.project || "",
        pasta: folder || agent.folder || "",
        areas: p.areas,
        arquivos_pretendidos: p.arquivos_pretendidos,
        agent,
        teamKey,
      });
      setAgentAutoMode(db, agent.id, true, pane);
      // openSession atualiza o registro; recarrega para current_task/session.
      agent = findAgentById(db, agent.id)!;
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(opened.sessionId) as SessionRow;
      const claimed = autoClaimNext(db, session, agent);

      recordEvent(db, opened.sessionId, "agent.open_auto", {
        agent_id: agent.id,
        team_key: teamKey,
        authority: agent.authority,
        work_item_id: claimed?.id ?? null,
      });
      postChat(db, {
        sessionId: opened.sessionId,
        sessionName: opened.sessionName,
        role: agent.role,
        type: "falar",
        agentId: agent.id,
        agentName: agent.name,
        message: isManagerAgent(agent)
          ? "Gerente online em modo auto; pronto para distribuir uma lista."
          : claimed
            ? `Online em modo auto; assumi ${claimed.id}: ${claimed.title}.`
            : "Online em modo auto; aguardando fila sem bloquear a equipe.",
      });

      return text([
        `${mode === "created" ? "ABERTO" : "RETOMADO"} · ${agent.name}/${agent.role}`,
        `agent_id: ${agent.id}`,
        `session_id: ${opened.sessionId}`,
        `task_id: ${opened.taskId}`,
        `team_key: ${teamKey}`,
        `autoridade: ${isManagerAgent(agent) ? "gerente" : "trabalhador"}`,
        "auto_mode: ATIVO",
        claimed ? `work_item: ${claimed.id} · ${claimed.title}` : "work_item: nenhum pronto",
        isManagerAgent(agent)
          ? "proximo_passo: receba a lista do usuário e chame distribuir_tarefas uma vez."
          : claimed
            ? "proximo_passo: execute agora; decida sozinho tudo que for reversível e entregue ao validar."
            : "proximo_passo: rode tick_autonomo compacto; ele assumirá automaticamente o primeiro item pronto.",
        renderContextoEntrada(db, teamKey, agent, opened.sessionId, p.arquivos_pretendidos, p.areas, p.recuperar),
      ].join("\n"));
    },
  },

  {
    name: "abrir_ou_retornar_agente",
    description:
      "Compatibilidade. Sem cargo, encaminha para a entrada única abrir (gerente eleito, papel dinâmico e auto imediato). Com cargo, mantém o fluxo legado.",
    inputSchema: {
      type: "object",
      properties: {
        cargo: { type: "string", description: "Papel livre (opcional no fluxo novo)." },
        tarefa: { type: "string", description: "Opcional em retomada — se omitida, mantém a tarefa anterior do agente." },
        projeto: { type: "string" },
        pasta: { type: "string", description: "Pasta de trabalho (chave de match com agentes existentes)." },
        areas: { type: "array", items: { type: "string" } },
        arquivos_pretendidos: { type: "array", items: { type: "string" } },
        preferred_name: { type: "string", description: "Se preencher, tenta retomar agente com esse nome." },
        force_new: { type: "boolean", default: false, description: "Ignora match, cria agente novo." },
        retomar_agente_id: { type: "string", description: "ID de agente específico a retomar." },
        recuperar: {
          type: "boolean",
          default: false,
          description: "Padrão false: entra limpo, sem despejar o histórico anterior. true traz último progresso, tarefa em andamento, inbox e time.",
        },
        tmux_pane: { type: "string", description: "Valor de $TMUX_PANE da pane atual (ex: %42). Passa explicitamente via Bash." },
      },
    },
    handler: (args) => {
      if (!args?.cargo) {
        const preferred = tools.find((tool) => tool.name === "abrir");
        return preferred!.handler(args ?? {});
      }
      const schema = z.object({
        cargo: z.string().min(1),
        tarefa: z.string().optional(),
        projeto: z.string().optional().default(""),
        pasta: z.string().optional().default(""),
        areas: z.array(z.string()).optional().default([]),
        arquivos_pretendidos: z.array(z.string()).optional().default([]),
        preferred_name: z.string().optional(),
        force_new: z.boolean().optional().default(false),
        retomar_agente_id: z.string().optional(),
        recuperar: z.boolean().optional().default(false),
        tmux_pane: z.string().optional(),
      });
      const p = schema.parse(args);
      const db = getDb();
      sweepSessions(db);

      let agent: AgentRow | null = null;
      let mode: "resumed" | "created" = "created";

      if (p.retomar_agente_id) {
        agent = findAgentById(db, p.retomar_agente_id);
        if (!agent) throw new Error(`Agente ${p.retomar_agente_id} não encontrado.`);
        // Mesma regra do abrir: arquivado não retoma por acidente. Antes este
        // caminho era o único que ignorava o arquivamento e "desarquivava"
        // sem querer. O caminho legítimo é desarquivar_agente.
        if (agent.status === "archived") {
          throw new Error(
            `Agente ${agent.name} está arquivado. Use desarquivar_agente antes de retomar.`
          );
        }
        mode = "resumed";
      } else if (p.preferred_name) {
        const existing = findAgentByName(db, p.preferred_name);
        if (existing && existing.status !== "archived") {
          agent = existing;
          mode = "resumed";
        }
      }

      // Fallback de pasta: se a skill/cliente não passou, herda do env.
      // AGENTDESK_FOLDER é setado pelo Electron pro PTY de cada tab. Sem isso
      // o MCP procura agentes com folder='' e SEMPRE cria novo — bug que
      // duplicava agentes (Lara + Igor mesmo backend, mesma pasta).
      let effectiveFolder = p.pasta;
      if (!effectiveFolder) {
        effectiveFolder = process.env.AGENTDESK_FOLDER || process.cwd();
      }

      if (!agent && !p.force_new) {
        let matches = findMatchingAgents(db, p.cargo, effectiveFolder);
        // Fallback 1: se há pasta específica mas não achou, procura em qualquer pasta
        // (pode ter sido registrado com pasta diferente no histórico).
        if (matches.length === 0 && effectiveFolder) {
          matches = findMatchingAgents(db, p.cargo, effectiveFolder, { anyFolder: true });
        }
        // Fallback 2: sem pasta E não achou folder='' — expande pra qualquer pasta.
        // Antes: ia direto pra "cria novo", ignorando agentes existentes em
        // outras pastas → duplicação. Agora: lista os existentes pra escolher.
        if (matches.length === 0 && !effectiveFolder) {
          matches = findMatchingAgents(db, p.cargo, null, { anyFolder: true });
        }
        if (matches.length === 1) {
          agent = matches[0];
          mode = "resumed";
        } else if (matches.length > 1) {
          const lines = [
            `Encontrei ${matches.length} agentes compatíveis (cargo=${p.cargo}, pasta=${effectiveFolder || "—"}).`,
            "Re-chame abrir_ou_retornar_agente com retomar_agente_id=<id> OU preferred_name=<nome> OU force_new=true:",
          ];
          for (const m of matches) {
            lines.push(`  - ${m.name} [id=${m.id}] status=${m.status} pasta=${m.folder || "—"} última atualização: ${new Date(m.updated_at).toISOString().replace("T", " ").slice(0, 19)}`);
          }
          return text(lines.join("\n"));
        }
      }

      const resolvedPane = p.tmux_pane || envTmuxPane();

      // Tarefa: obrigatória para agente NOVO, opcional para retomada (default = tarefa anterior)
      let resolvedTarefa: string;
      if (!agent) {
        if (!p.tarefa) {
          throw new Error(
            `Para criar um agente NOVO de ${p.cargo} é preciso informar a tarefa. Re-chame com tarefa="...".`
          );
        }
        resolvedTarefa = p.tarefa;
        const name = p.preferred_name && !findAgentByName(db, p.preferred_name) ? p.preferred_name : pickUniqueName(db);
        agent = createAgent(db, {
          name,
          role: p.cargo,
          authority: p.cargo === MANAGER_ROLE && !findManagerForTeam(db, deriveTeamKey(effectiveFolder, p.projeto))
            ? "manager"
            : "worker",
          team_key: deriveTeamKey(effectiveFolder, p.projeto),
          project: p.projeto,
          folder: effectiveFolder,
          tmux_pane: resolvedPane,
        });
        mode = "created";
      } else {
        // Retomada: atualiza tmux_pane sempre que tiver valor.
        if (resolvedPane) {
          db.prepare("UPDATE agents SET tmux_pane = ? WHERE id = ?").run(resolvedPane, agent.id);
        }
        // Default da tarefa: título da tarefa anterior, ou "Continuação".
        if (p.tarefa) {
          resolvedTarefa = p.tarefa;
        } else if (agent.current_task_id) {
          const t = db.prepare("SELECT title FROM tasks WHERE id = ?").get(agent.current_task_id) as
            | { title: string }
            | undefined;
          resolvedTarefa = t?.title || "Continuação";
        } else {
          resolvedTarefa = "Continuação";
        }
      }

      // Se o agente tem sessão dead (interrompida, não fechada), ressuscita ela.
      // Evita criar Frontend-17, -18, -19... a cada restart.
      const deadSession = agent.current_session_id
        ? (db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'dead'").get(agent.current_session_id) as any)
        : null;

      const { sessionId, sessionName, taskId } = deadSession
        ? reopenSession(db, deadSession.id, resolvedTarefa, agent)
        : openSession(db, {
            cargo: p.cargo,
            tarefa: resolvedTarefa,
            projeto: p.projeto,
            pasta: effectiveFolder,
            areas: p.areas,
            arquivos_pretendidos: p.arquivos_pretendidos,
            agent,
            teamKey: agent.team_key,
          });

      // Abertura passa a implicar auto também no alias antigo.
      setAgentAutoMode(db, agent.id, true, resolvedPane);

      recordEvent(db, sessionId, mode === "resumed" ? "agent.resumed" : "agent.created", {
        agent_id: agent.id,
        agent_name: agent.name,
        role: p.cargo,
        task: resolvedTarefa,
      });

      postChat(db, {
        sessionId,
        sessionName,
        role: p.cargo,
        type: "falar",
        agentId: agent.id,
        agentName: agent.name,
        message: mode === "resumed"
          ? `Voltei. Retomando como ${agent.name}. Tarefa: ${resolvedTarefa}.`
          : `Entrei na equipe. Sou ${agent.name}. Tarefa: ${resolvedTarefa}.`,
      });

      // Cursor de inbox: last_seen_ms (atualizado por marcar_lido). NÃO usar
      // last_heartbeat — heartbeat avança a cada tool call e esconderia mensagens
      // chegadas depois do último tool call mas antes de marcar_lido.
      const since = agent.last_seen_ms || agent.created_at;
      const inbox = p.recuperar ? renderInbox(db, agent, since) : "";
      const ctx = p.recuperar ? renderTeamContext(db) : "";

      // Restauração de contexto (só em modo resumed E sob pedido): progresso
      // anterior + tarefa em andamento + últimos updates. Sem o pedido, a
      // janela nova não herda histórico velho da pasta.
      const restoreLines: string[] = [];
      if (mode === "resumed" && p.recuperar) {
        if (agent.progress_summary) {
          restoreLines.push("── ÚLTIMO PROGRESSO ──");
          restoreLines.push(agent.progress_summary);
          restoreLines.push("");
        }
        // Tarefa em andamento (current_task_id)
        if (agent.current_task_id) {
          const task = db.prepare("SELECT title, description, status FROM tasks WHERE id = ?").get(agent.current_task_id) as
            | { title: string; description: string | null; status: string }
            | undefined;
          if (task) {
            restoreLines.push("── TAREFA EM ANDAMENTO ──");
            restoreLines.push(`${task.title}  [${task.status}]`);
            if (task.description) restoreLines.push(task.description);
            restoreLines.push("");
            // Últimos 5 updates dessa tarefa
            const updates = db
              .prepare("SELECT progress, created_at FROM updates WHERE task_id = ? ORDER BY created_at DESC LIMIT 5")
              .all(agent.current_task_id) as Array<{ progress: string; created_at: number }>;
            if (updates.length) {
              restoreLines.push("Updates recentes:");
              for (const u of updates.reverse()) {
                const t = new Date(u.created_at).toISOString().replace("T", " ").slice(0, 16);
                restoreLines.push(`  [${t}] ${u.progress}`);
              }
              restoreLines.push("");
            }
          }
        }
      }

      return text(
        [
          mode === "resumed" ? `Agente retomado: ${agent.name}` : `Agente criado: ${agent.name}`,
          `agent_id: ${agent.id}`,
          `session_id: ${sessionId}  (nome: ${sessionName})`,
          `task_id: ${taskId}`,
          `Papel: ${p.cargo}  Pasta: ${effectiveFolder || "—"}`,
          "auto_mode: ATIVO",
          "",
          ...(p.recuperar
            ? [...restoreLines, "── INBOX ──", inbox, "", "── TIME ──", ctx, ""]
            : [renderResumoEntrada(db, agent.team_key, agent), ""]),
          "Guarde agent_id e session_id. Próximos comandos:",
          "  /status, /inbox, /falar, /pedir, /travar, /atualizar, /feito, /fechar",
        ].join("\n")
      );
    },
  },

  {
    name: "listar_agentes",
    description: "Lista agentes da equipe do chamador (todas_equipes=true para todos) com nome, autoridade, papel atual, status, tarefa e atividade.",
    inputSchema: {
      type: "object",
      properties: {
        incluir_arquivados: { type: "boolean", default: false },
        ...ESCOPO_PROPS,
      },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const teamKey = resolveTeamScope(db, args);
      const agents = teamKey
        ? listAgentsForTeam(db, teamKey, { include_archived: !!args?.incluir_arquivados })
        : listAgents(db, { include_archived: !!args?.incluir_arquivados });
      if (!agents.length) return text(`Nenhum agente registrado. ${cabecalhoEscopo(teamKey)}`);
      const lines: string[] = [cabecalhoEscopo(teamKey), `Total: ${agents.length} agente(s).`, ""];
      for (const a of agents) {
        const sess = a.current_session_id
          ? (db.prepare("SELECT name, status FROM sessions WHERE id = ?").get(a.current_session_id) as
              | { name: string; status: string }
              | undefined)
          : null;
        const task = a.current_task_id
          ? (db.prepare("SELECT title, status FROM tasks WHERE id = ?").get(a.current_task_id) as
              | { title: string; status: string }
              | undefined)
          : null;
        const upd = new Date(a.updated_at).toISOString().replace("T", " ").slice(0, 19);
        lines.push(
          `- ${a.name} [${a.role}] autoridade=${a.authority} status=${anotaSemNoticias(a.status, a.last_heartbeat)} (atualizado ${upd})\n    id: ${a.id}  equipe: ${a.team_key}\n    pasta: ${a.folder || "—"}    projeto: ${a.project || "—"}\n    sessão atual: ${sess ? `${sess.name} (${sess.status})` : "—"}\n    tarefa atual: ${task ? `${task.title} [${task.status}]` : "—"}`
        );
      }
      return text(lines.join("\n"));
    },
  },

  {
    name: "retomar_agente",
    description: "Retoma um agente pelo id ou nome — abre uma nova sessão runtime ligada a ele. Use quando souber exatamente qual agente reativar.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent_id ou nome do agente (ex: 'Jonathan')." },
        cargo: { type: "string", description: "Opcional — sobrescreve o papel, sem alterar autoridade." },
        tarefa: { type: "string" },
        projeto: { type: "string" },
        pasta: { type: "string" },
        areas: { type: "array", items: { type: "string" } },
        arquivos_pretendidos: { type: "array", items: { type: "string" } },
      },
      required: ["agent", "tarefa"],
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const ag = getAgentByIdentifier(db, args.agent);
      if (!ag) throw new Error(`Agente '${args.agent}' não encontrado. Use listar_agentes.`);
      if (ag.status === "archived") throw new Error(`Agente ${ag.name} está arquivado. Desarquive antes.`);

      // Se já tem sessão runtime viva, recusa (evita criar 2 sessões pro mesmo
      // agente — corrompe current_session_id e deixa sessão órfã).
      if (ag.current_session_id) {
        const existing = db.prepare("SELECT id, name, status, last_heartbeat, closed_at FROM sessions WHERE id = ?")
          .get(ag.current_session_id) as
          | { id: string; name: string; status: any; last_heartbeat: number; closed_at: number | null }
          | undefined;
        if (existing) {
          const st = deriveStatus(existing);
          if (st === "active" || st === "suspect") {
            throw new Error(
              `Agente ${ag.name} já tem sessão ativa (${existing.name}, status=${st}). ` +
                `Use /pausar ou /fechar antes de retomar — abrir duas sessões corrompe o estado.`
            );
          }
        }
      }

      const cargo = args.cargo ?? ag.role;
      // Pane atual: a tool é chamada DENTRO do Claude novo; herda TMUX_PANE do env.
      const pane = envTmuxPane();
      if (pane && pane !== ag.tmux_pane) {
        db.prepare("UPDATE agents SET tmux_pane = ? WHERE id = ?").run(pane, ag.id);
      }

      const { sessionId, sessionName, taskId } = openSession(db, {
        cargo,
        tarefa: args.tarefa,
        projeto: args.projeto ?? ag.project ?? "",
        pasta: args.pasta ?? ag.folder ?? "",
        areas: args.areas,
        arquivos_pretendidos: args.arquivos_pretendidos,
        agent: ag,
      });
      recordEvent(db, sessionId, "agent.resumed", { agent_id: ag.id, agent_name: ag.name });
      postChat(db, {
        sessionId,
        sessionName,
        role: cargo,
        type: "falar",
        agentId: ag.id,
        agentName: ag.name,
        message: `Voltei. Tarefa: ${args.tarefa}.`,
      });
      // Cursor uniforme: usa o cursor de "visto" (last_seen_ms) em vez de
      // last_heartbeat — heartbeat avança a cada tool call e esconde o inbox.
      const since = ag.last_seen_ms || ag.created_at;
      const inbox = renderInbox(db, ag, since);
      return text(
        [
          `Agente ${ag.name} retomado.`,
          `agent_id: ${ag.id}`,
          `session_id: ${sessionId}  (nome: ${sessionName})`,
          `task_id: ${taskId}`,
          ag.auto_mode ? "⚠ Você estava em modo autônomo antes — auto_mode continua ATIVO. Rode /auto se quiser desligar." : "",
          "",
          inbox,
        ].filter(Boolean).join("\n")
      );
    },
  },

  {
    name: "pausar_agente",
    description: "Pausa o agente da sessão atual (sem apagar histórico). A sessão atual é fechada e o agente fica disponível pra retomada depois.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        motivo: { type: "string" },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      if (!ag) throw new Error("Esta sessão não tem agente vinculado (foi aberta com abrir_sessao legacy?).");
      const ts = now();
      // Mesma atomicidade do fechar_sessao.
      const tx = db.transaction(() => {
        releaseLocks(db, s.id);
        db.prepare(
          "UPDATE tasks SET status = 'pending', updated_at = ? WHERE session_id = ? AND status = 'in_progress'"
        ).run(ts, s.id);
        db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(ts, s.id);
        setAgentStatus(db, ag.id, "paused", { current_session_id: null, current_task_id: null });
      });
      tx.immediate();
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "falar",
        agentId: ag.id,
        agentName: ag.name,
        message: `Pausando. ${args.motivo ?? ""}`.trim(),
      });
      recordEvent(db, s.id, "agent.paused", { agent_id: ag.id, motivo: args.motivo ?? null });
      return text(`Agente ${ag.name} pausado. Sessão ${s.name} fechada. Pode ser retomado com /abrir ou retomar_agente.`);
    },
  },

  {
    name: "arquivar_agente",
    description: "Arquiva um agente PERMANENTEMENTE (não aparece em matches). Use só quando quiser remover da equipe. Não apaga histórico.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent_id ou nome." },
      },
      required: ["agent"],
    },
    handler: (args) => {
      const db = getDb();
      const ag = getAgentByIdentifier(db, args.agent);
      if (!ag) throw new Error(`Agente '${args.agent}' não encontrado.`);
      if (ag.current_session_id) {
        const s = db.prepare("SELECT status FROM sessions WHERE id = ?").get(ag.current_session_id) as
          | { status: string }
          | undefined;
        if (s && s.status === "active") {
          throw new Error(`Agente ${ag.name} ainda tem sessão ativa. Feche a sessão antes (/fechar ou /pausar).`);
        }
      }
      setAgentStatus(db, ag.id, "archived", { current_session_id: null, current_task_id: null });
      recordEvent(db, null, "agent.archived", { agent_id: ag.id, agent_name: ag.name });
      return text(`Agente ${ag.name} arquivado. Histórico preservado. Para reativar depois: desarquivar_agente.`);
    },
  },

  {
    name: "desarquivar_agente",
    description:
      "Reativa um agente arquivado (volta como 'paused', pronto para retomar com abrir). Se a equipe já elegeu outro gerente nesse meio tempo, o desarquivado volta como trabalhador.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent_id ou nome." },
      },
      required: ["agent"],
    },
    handler: (args) => {
      const db = getDb();
      const ag = getAgentByIdentifier(db, args.agent);
      if (!ag) throw new Error(`Agente '${args.agent}' não encontrado.`);
      if (ag.status !== "archived") {
        return text(`Agente ${ag.name} não está arquivado (status=${ag.status}). Nada a fazer.`);
      }
      const ts = now();
      const tx = db.transaction(() => {
        // A equipe só pode ter um gerente ativo (índice único). Se outro foi
        // eleito enquanto este esteve arquivado, ele volta como trabalhador.
        if (ag.authority === "manager") {
          const atual = findManagerForTeam(db, ag.team_key);
          if (atual && atual.id !== ag.id) {
            db.prepare("UPDATE agents SET authority = 'worker', updated_at = ? WHERE id = ?").run(ts, ag.id);
          }
        }
        db.prepare(
          "UPDATE agents SET status = 'paused', updated_at = ?, current_session_id = NULL, current_task_id = NULL WHERE id = ?"
        ).run(ts, ag.id);
      });
      tx.immediate();
      const depois = findAgentById(db, ag.id)!;
      recordEvent(db, null, "agent.unarchived", { agent_id: ag.id, agent_name: ag.name });
      return text(
        `Agente ${ag.name} desarquivado (status paused, autoridade ${depois.authority === "manager" ? "gerente" : "trabalhador"}). ` +
          `Retome com abrir (retomar_agente_id=${ag.id}).`
      );
    },
  },

  {
    name: "inbox_agente",
    description:
      "Retorna pendências do agente atual por nome ou papel, alertas e handoffs desde o último cursor.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Opcional se passar agent." },
        agent: { type: "string", description: "Opcional — agent_id ou nome (se você não tem session aberta)." },
        since_ts: { type: "number", description: "Override do timestamp inicial." },
      },
    },
    handler: (args) => {
      const db = getDb();
      let ag: AgentRow | null = null;
      if (args?.agent) {
        ag = getAgentByIdentifier(db, args.agent);
      } else if (args?.session_id) {
        const s = requireActiveSession(db, args.session_id);
        ag = getAgentByActiveSession(db, s.id);
        db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
        if (ag) touchAgent(db, ag.id);
      }
      if (!ag) throw new Error("Informe session_id (com agente vinculado) ou agent (id/nome).");
      const since = args?.since_ts ?? ag.last_heartbeat ?? ag.created_at;
      return text(renderInbox(db, ag, since));
    },
  },

  // ─── Work items estruturados ─────────────────────────────────────────────

  {
    name: "atribuir_papel",
    description:
      "O gerente atribui ou troca o papel livre de um agente da mesma equipe. Papel não concede autoridade e não vem de uma lista fixa.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        agente: { type: "string", description: "Nome ou agent_id do trabalhador." },
        papel: { type: "string", description: "Papel curto decidido pelo gerente para o trabalho atual." },
      },
      required: ["session_id", "agente", "papel"],
    },
    handler: (args) => {
      const parsed = z.object({
        session_id: z.string().min(1),
        agente: z.string().min(1),
        papel: z.string().trim().min(1).max(80),
      }).parse(args);
      const db = getDb();
      const session = requireActiveSession(db, parsed.session_id);
      const manager = getManagerForSession(db, session);
      const updated = assignAgentRole(db, {
        managerAgentId: manager.id,
        target: parsed.agente,
        role: parsed.papel,
      });
      postChat(db, {
        sessionId: session.id,
        sessionName: session.name,
        role: session.role,
        type: "decisao",
        to: updated.name,
        message: `Papel atual: ${updated.role}. Assuma decisões reversíveis dentro desse escopo sem aguardar aprovação.`,
        agentId: manager.id,
        agentName: manager.name,
      });
      recordEvent(db, session.id, "agent.role_assigned", {
        target: updated.id,
        role: updated.role,
      });
      return text(`Papel atribuído: ${updated.name} -> ${updated.role}\nautoridade: trabalhador (inalterada)`);
    },
  },

  {
    name: "distribuir_tarefas",
    description:
      "Gerente transforma uma lista inteira em work items numa chamada e os balanceia entre trabalhadores ativos. Aceita dependências por chave do mesmo lote; itens prontos rodam em paralelo e excedentes ficam na fila para work stealing.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        tarefas: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              chave: { type: "string", description: "Apelido único para dependências dentro do lote." },
              titulo: { type: "string" },
              descricao: { type: "string" },
              aceite: { type: "string" },
              prioridade: { type: "string", enum: ["baixa", "normal", "alta", "critica"] },
              papel: { type: "string", description: "Papel livre escolhido pelo gerente." },
              para: { type: "string", description: "Nome/ID explícito de um trabalhador, se necessário." },
              areas: { type: "array", items: { type: "string" } },
              arquivos_ou_escopos: { type: "array", items: { type: "string" } },
              dependencias: { type: "array", items: { type: "string" }, description: "Chaves do lote, IDs existentes ou notas." },
            },
            required: ["titulo"],
          },
        },
        estrategia: { type: "string", enum: ["balanceada", "especialidade", "fila"], default: "balanceada" },
        paralelismo: { type: "number", minimum: 1, description: "Máximo de trabalhadores usados de imediato." },
      },
      required: ["session_id", "tarefas"],
    },
    handler: (args) => {
      const itemSchema = z.object({
        chave: z.string().trim().min(1).max(80).optional(),
        titulo: z.string().trim().min(1).max(500),
        descricao: z.string().optional(),
        aceite: z.string().optional(),
        prioridade: z.enum(["baixa", "normal", "alta", "critica"]).optional().default("normal"),
        papel: z.string().trim().min(1).max(80).optional(),
        para: z.string().optional(),
        areas: z.array(z.string()).optional().default([]),
        arquivos_ou_escopos: z.array(z.string()).optional().default([]),
        dependencias: z.array(z.string()).optional().default([]),
      });
      const p = z.object({
        session_id: z.string().min(1),
        tarefas: z.array(itemSchema).min(1).max(100),
        estrategia: z.enum(["balanceada", "especialidade", "fila"]).optional().default("balanceada"),
        paralelismo: z.number().int().positive().optional(),
      }).parse(args);

      const db = getDb();
      const session = requireActiveSession(db, p.session_id);
      const manager = getManagerForSession(db, session);
      const teamKey = teamKeyForSession(session, manager);
      const keys = new Set<string>();
      for (const [index, task] of p.tarefas.entries()) {
        const key = task.chave ?? String(index + 1);
        if (keys.has(key)) throw new Error(`Chave duplicada no lote: ${key}.`);
        keys.add(key);
      }
      for (const task of p.tarefas) {
        for (const dependency of task.dependencias) {
          if (keys.has(dependency)) continue;
          const existing = getWorkItem(db, dependency);
          if (existing && existing.team_key === teamKey) continue;
          // Tokens simples são referências, não notas: um typo não pode criar
          // um lote parcialmente impossível. Para contexto livre use "nota:...".
          if (!dependency.startsWith("nota:")) {
            throw new Error(
              `Dependência '${dependency}' não corresponde a uma chave do lote nem a um work item da equipe. ` +
              `Prefixe notas livres com 'nota:'.`
            );
          }
        }
      }

      const allWorkers = listAgentsForTeam(db, teamKey)
        .filter((agent) => !isManagerAgent(agent) && !["archived", "dead"].includes(agent.status));
      const liveWorkers = allWorkers.filter((agent) => {
        if (!agent.current_session_id) return false;
        const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(agent.current_session_id) as SessionRow | undefined;
        return !!row && ["active", "suspect"].includes(deriveStatus(row));
      });
      const workerLimit = Math.min(p.paralelismo ?? liveWorkers.length, liveWorkers.length);
      const workers = liveWorkers.slice(0, workerLimit);
      const loads = new Map<string, number>();
      for (const worker of workers) {
        const row = db.prepare(
          `SELECT COUNT(*) AS n FROM work_items
           WHERE team_key = ? AND status IN ('queued','claimed','working')
             AND (assigned_to = ? OR owner_agent_id = ?)`
        ).get(teamKey, worker.name, worker.id) as { n: number };
        loads.set(worker.id, row.n);
      }

      const planned = p.tarefas.map((task, index) => {
        const role = task.papel || (task.areas[0] ? `especialista:${task.areas[0]}` : "generalista");
        let target: AgentRow | null = null;
        if (task.para) {
          target = getAgentByIdentifier(db, task.para);
          if (!target || target.team_key !== teamKey || target.status === "archived" || isManagerAgent(target)) {
            throw new Error(`Destino '${task.para}' não é um trabalhador ativo desta equipe.`);
          }
        } else if (p.estrategia !== "fila" && workers.length) {
          const candidates = p.estrategia === "especialidade"
            ? [...workers].sort((a, b) => {
                const affinity = Number(b.role === role) - Number(a.role === role);
                return affinity || (loads.get(a.id)! - loads.get(b.id)!);
              })
            : [...workers].sort((a, b) => loads.get(a.id)! - loads.get(b.id)!);
          target = candidates[0] ?? null;
        }
        if (target) loads.set(target.id, (loads.get(target.id) ?? 0) + 1);
        return { task, index, key: task.chave ?? String(index + 1), role, target };
      });

      const created: Array<{ key: string; item: WorkItemRow; role: string; target: AgentRow | null }> = [];
      const tx = db.transaction(() => {
        for (const plan of planned) {
          const item = createWorkItem(db, {
            title: plan.task.titulo,
            description: plan.task.descricao ?? null,
            acceptance: plan.task.aceite ?? "Entregar com validação objetiva; escalar somente risco irreversível ou bloqueio externo.",
            priority: plan.task.prioridade,
            team_key: teamKey,
            project: session.project ?? manager.project,
            folder: session.folder ?? manager.folder,
            areas: plan.task.areas,
            intended_files: plan.task.arquivos_ou_escopos,
            dependencies: [],
            assigned_to: plan.target?.name ?? null,
            assigned_role: plan.role,
            created_by_session: session.id,
            created_by_agent: manager.name,
          });
          created.push({ key: plan.key, item, role: plan.role, target: plan.target });
        }
        const idByKey = new Map(created.map((entry) => [entry.key, entry.item.id]));
        for (const entry of created) {
          const original = planned.find((plan) => plan.key === entry.key)!;
          const dependencies = original.task.dependencias.map((dependency) => idByKey.get(dependency) ?? dependency);
          db.prepare("UPDATE work_items SET dependencies = ?, updated_at = ? WHERE id = ?")
            .run(dependencies.length ? JSON.stringify(dependencies) : null, now(), entry.item.id);
          entry.item = getWorkItem(db, entry.item.id)!;
        }
      });
      tx.immediate();

      // Um trabalhador disponível passa a se identificar pelo primeiro papel
      // que o gerente acabou de lhe atribuir. Autoridade não muda.
      const firstByTarget = new Map<string, string>();
      for (const entry of created) {
        if (entry.target && !firstByTarget.has(entry.target.id)) firstByTarget.set(entry.target.id, entry.role);
      }
      for (const [targetId, role] of firstByTarget) {
        const target = findAgentById(db, targetId);
        if (target && target.role === AVAILABLE_ROLE) {
          assignAgentRole(db, { managerAgentId: manager.id, target: target.id, role });
        }
      }

      postChat(db, {
        sessionId: session.id,
        sessionName: session.name,
        role: session.role,
        type: "decisao",
        message: `Lote distribuído: ${created.length} itens, ${new Set(created.map((entry) => entry.target?.id).filter(Boolean)).size} trabalhadores imediatos, estratégia ${p.estrategia}.`,
        agentId: manager.id,
        agentName: manager.name,
      });
      recordEvent(db, session.id, "work_items.batch_distributed", {
        count: created.length,
        strategy: p.estrategia,
        parallelism: workerLimit,
        ids: created.map((entry) => entry.item.id),
      });

      const lines = [
        `LOTE DISTRIBUÍDO · ${created.length} itens · paralelismo imediato ${new Set(created.map((entry) => entry.target?.id).filter(Boolean)).size}`,
      ];
      for (const entry of created) {
        const deps = parseJsonList(entry.item.dependencies);
        lines.push(
          `- ${entry.key}=${entry.item.id} [${entry.item.priority}] -> ${entry.target?.name ?? "fila"}/${entry.role}: ${entry.item.title}${deps.length ? ` (dep: ${deps.join(",")})` : ""}`
        );
      }
      lines.push("Agentes em auto assumem itens prontos sem nova decisão do gerente.");
      return text(lines.join("\n"));
    },
  },

  {
    name: "criar_tarefa_estruturada",
    description:
      "Cria uma tarefa estruturada com dono/alvo, escopos de arquivo, dependências e critério de aceite. Preferível a delegar só por chat quando há mais de um Claude trabalhando.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        titulo: { type: "string" },
        descricao: { type: "string" },
        aceite: { type: "string", description: "Critério objetivo para considerar pronto." },
        prioridade: { type: "string", enum: ["baixa", "normal", "alta", "critica"], default: "normal" },
        para: { type: "string", description: "Nome do agente ou papel atual alvo." },
        projeto: { type: "string" },
        pasta: { type: "string" },
        areas: { type: "array", items: { type: "string" } },
        arquivos_ou_escopos: { type: "array", items: { type: "string" }, description: "Arquivos, diretórios com /** ou globs." },
        dependencias: { type: "array", items: { type: "string" }, description: "IDs de work items ou notas curtas." },
      },
      required: ["session_id", "titulo"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const target = args.para as string | undefined;
      const targetAgent = target ? getAgentByIdentifier(db, target) : null;
      if (targetAgent && targetAgent.status === "archived") {
        throw new Error(
          `Agente ${targetAgent.name} está arquivado. Escolha outro destinatário ou desarquive antes.`
        );
      }
      if (targetAgent && targetAgent.team_key !== teamKeyForSession(s, ag)) {
        throw new Error(`Agente ${targetAgent.name} pertence a outra equipe.`);
      }
      // Valida dependências: cada string que parece work_item_id (12 chars
      // alfanuméricos/_-) precisa existir. Notas livres passam.
      const deps = (args.dependencias ?? []) as string[];
      const idLike = (s: string) => /^[A-Za-z0-9_-]{8,16}$/.test(s);
      for (const d of deps) {
        if (idLike(d)) {
          const exists = getWorkItem(db, d);
          if (!exists) {
            throw new Error(
              `Dependência '${d}' parece um work_item_id mas não existe. Use ID válido ou nota livre.`
            );
          }
        }
      }
      const item = createWorkItem(db, {
        title: args.titulo,
        description: args.descricao ?? null,
        acceptance: args.aceite ?? null,
        priority: args.prioridade ?? "normal",
        team_key: teamKeyForSession(s, ag),
        project: args.projeto ?? s.project ?? null,
        folder: args.pasta ?? s.folder ?? null,
        areas: args.areas ?? [],
        intended_files: args.arquivos_ou_escopos ?? [],
        dependencies: args.dependencias ?? [],
        assigned_to: targetAgent ? targetAgent.name : null,
        assigned_role: targetAgent ? targetAgent.role : target ?? null,
        created_by_session: s.id,
        created_by_agent: ag?.name ?? null,
      });

      if (target) {
        postChat(db, {
          sessionId: s.id,
          sessionName: s.name,
          role: s.role,
          type: "decisao",
          to: target,
          message: `WORK ITEM ${item.id}: ${item.title}`,
          agentId: ag?.id ?? null,
          agentName: ag?.name ?? null,
        });
      }
      recordEvent(db, s.id, "work_item.created", { id: item.id, target });
      return text(`Work item criado:\n${formatWorkItem(item)}`);
    },
  },

  {
    name: "listar_tarefas_estruturadas",
    description:
      "Lista work items estruturados da equipe do chamador (todas_equipes=true para todos). Pode filtrar por status, agente ou papel atual.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["queued", "claimed", "working", "blocked", "review", "done", "canceled"] },
        para: { type: "string", description: "Nome do agente ou papel atual." },
        limite: { type: "number", default: 30 },
        ...ESCOPO_PROPS,
      },
    },
    handler: (args) => {
      const db = getDb();
      const teamKey = resolveTeamScope(db, args);
      const rows = listWorkItems(db, {
        status: args?.status ?? null,
        assigned: args?.para ?? null,
        limit: args?.limite ?? 30,
        team_key: teamKey,
      });
      if (!rows.length) return text(`Nenhum work item encontrado. ${cabecalhoEscopo(teamKey)}`);
      return text([cabecalhoEscopo(teamKey), "", ...rows.map(formatWorkItem)].join("\n\n"));
    },
  },

  {
    name: "assumir_tarefa",
    description:
      "Assume um work item estruturado, opcionalmente trava seus arquivos/escopos e cria uma worktree isolada para o agente.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        travar: { type: "boolean", default: true },
        criar_worktree: { type: "boolean", default: true },
      },
      required: ["session_id", "work_item_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const itemBefore = getWorkItem(db, args.work_item_id);
      if (!itemBefore) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
      if (!ag || itemBefore.team_key !== teamKeyForSession(s, ag)) {
        throw new Error("Work item pertence a outra equipe.");
      }

      // Etapa 1: tenta locks ANTES de claim. Se houver conflito, o item nem sai
      // de "queued" — outro agente pode assumir. Antes: o item ficava "working"
      // e depois virava "blocked", confundindo o histórico e bloqueando outros.
      const scopes = parseJsonList(itemBefore.intended_files);
      let lockText = "Locks: não solicitados.";
      let lockConflictReason: string | null = null;
      if (args.travar !== false && scopes.length) {
        const r = acquireLocks(
          db,
          s.id,
          scopes,
          parseJsonList(itemBefore.areas)[0],
          ag ? { id: ag.id, name: ag.name } : null
        );
        if (r.conflicts.length) {
          lockConflictReason = `Conflito de lock: ${r.conflicts
            .map((c) => `${c.file} vs ${c.held_file} por ${c.held_by_name}`)
            .join("; ")}`;
          lockText =
            "Conflitos de lock:\n" +
            r.conflicts.map((c) => `  - ${c.file} conflita com ${c.held_file} de ${c.held_by_name}/${c.held_by_role}`).join("\n");
        } else {
          lockText = `Locks concedidos: ${r.granted.map((g) => g.file).join(", ") || "nenhum"}`;
        }
      }

      // Se locks falharam, marca o item como blocked SEM virar dono — outro
      // agente pode assumir quando o lock for liberado.
      if (lockConflictReason) {
        // acquireLocks pode ter concedido escopos anteriores antes de achar o
        // conflito; devolve tudo para não deixar lock parcial órfão.
        releaseLocks(db, s.id, scopes);
        updateWorkItemStatus(db, args.work_item_id, "blocked", { blocked_reason: lockConflictReason });
        recordEvent(db, s.id, "work_item.lock_conflict", { id: args.work_item_id, reason: lockConflictReason });
        return text([
          `Não foi possível assumir ${args.work_item_id} — locks em conflito.`,
          `Status: blocked (motivo registrado).`,
          ``,
          lockText,
        ].join("\n"));
      }

      // Etapa 2: claim atômico (UPDATE … RETURNING). Se outro agente assumiu
      // entre a checagem de lock e aqui, esta linha lança.
      let item: WorkItemRow;
      try {
        item = claimWorkItem(db, args.work_item_id, {
          agent_id: ag?.id ?? null,
          agent_name: ag?.name ?? s.name,
          session_id: s.id,
          agent_role: ag?.role ?? s.role,
          allow_role_adoption: ag?.role === AVAILABLE_ROLE,
        });
      } catch (e) {
        // Rollback dos locks que acabamos de pegar — outro agente é o dono.
        if (scopes.length) releaseLocks(db, s.id, scopes);
        throw e;
      }

      if (ag) adoptWorkItemRole(db, s, ag, item);

      // Etapa 3: worktree (opcional). Falha aqui NÃO desfaz o claim — o item
      // continua "working" sem worktree, e o agente pode trabalhar in-place.
      // Antes silenciava o erro real; agora registra.
      let wtText = "Worktree: não solicitada.";
      if (args.criar_worktree !== false) {
        const folder = item.folder || s.folder;
        if (folder && ag?.name) {
          try {
            const wt = prepareWorktree({ folder, agentName: ag.name, workItemId: item.id, title: item.title });
            updateWorkItemStatus(db, item.id, "working", { worktree_path: wt.path, branch_name: wt.branch });
            wtText = `Worktree ${wt.created ? "criada" : "reutilizada"}: ${wt.path}\nBranch: ${wt.branch}`;
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            wtText = `Worktree falhou: ${msg} — item continua claimed sem worktree.`;
            recordEvent(db, s.id, "work_item.worktree_failed", { id: item.id, error: msg });
          }
        } else {
          wtText = "Worktree: sem pasta git ou agente nomeado — pulada.";
        }
      }

      recordEvent(db, s.id, "work_item.claimed", { id: item.id, agent: ag?.name ?? s.name });
      return text([
        `Work item assumido por ${ag?.name ?? s.name}:`,
        formatWorkItem(getWorkItem(db, item.id) ?? item),
        "",
        lockText,
        wtText,
      ].join("\n"));
    },
  },

  {
    name: "bloquear_tarefa",
    description:
      "Marca um work item como bloqueado com motivo concreto e avisa no chat.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        motivo: { type: "string" },
      },
      required: ["session_id", "work_item_id", "motivo"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const current = getWorkItem(db, args.work_item_id);
      if (!current) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
      if (!ag || current.team_key !== teamKeyForSession(s, ag)) {
        throw new Error("Work item pertence a outra equipe.");
      }

      // Só o dono ou o gerente pode bloquear. Antes: qualquer um podia.
      const isOwner = !!ag && current.owner_agent_id === ag.id;
      const isGerente = isManagerAgent(ag);
      if (!isOwner && !isGerente) {
        throw new Error(
          `Apenas o dono (${current.owner_agent_name ?? "—"}) ou um gerente pode bloquear o work item ${current.id}.`
        );
      }

      const item = updateWorkItemStatus(db, args.work_item_id, "blocked", { blocked_reason: args.motivo });
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "alerta",
        message: `BLOQUEADO work item ${item.id}: ${args.motivo}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "work_item.blocked", { id: item.id, reason: args.motivo });
      let next: WorkItemRow | null = null;
      if (isOwner && ag) {
        releaseLocks(db, s.id);
        next = autoClaimNext(db, s, ag);
      }
      return text([
        `Work item bloqueado: ${item.id} · ${args.motivo}`,
        next
          ? `Próximo item assumido sem espera: ${next.id} · ${next.title}`
          : "Sem outro item pronto; o bloqueio foi escalado de forma assíncrona.",
      ].join("\n"));
    },
  },

  {
    name: "entregar_tarefa",
    description:
      "Entrega um work item para review. Informe resumo e validação executada. Passe 'comando' com o build/test/check da entrega: o MCP roda de verdade na worktree e recusa a entrega se falhar. Sem comando, a entrega vai marcada como não verificada.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        resumo: { type: "string" },
        validacao: { type: "string", description: "Comandos/checagens executados ou justificativa se não rodou." },
        comando: {
          type: "string",
          description: "Comando de validação a executar como prova (ex: 'npm test', 'npx tsc --noEmit'). Roda na worktree do item.",
        },
        timeout_s: { type: "number", default: 300, description: "Tempo máximo do comando de prova (10 a 1800s)." },
        manter_travas: { type: "boolean", default: false },
      },
      required: ["session_id", "work_item_id", "resumo", "validacao"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const current = getWorkItem(db, args.work_item_id);
      if (!current) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
      if (!ag || current.team_key !== teamKeyForSession(s, ag)) {
        throw new Error("Work item pertence a outra equipe.");
      }

      // Só o dono entrega. Antes: qualquer agente podia entregar tarefa alheia
      // (e ainda liberava locks do entregador, não do dono).
      if (!ag || current.owner_agent_id !== ag.id) {
        throw new Error(
          `Apenas o dono pode entregar. Work item ${current.id} pertence a ${current.owner_agent_name ?? "—"}.`
        );
      }
      if (!["working", "claimed"].includes(current.status)) {
        throw new Error(`Work item ${current.id} está em status ${current.status}; só working/claimed entrega.`);
      }

      // Prova da entrega. Sem comando, a entrega passa mas fica marcada como
      // não verificada, para o revisor saber o que está aprovando.
      let validacao: string = args.validacao;
      if (args.comando) {
        const cwd = [current.worktree_path, current.folder, s.folder]
          .find((dir) => dir && existsSync(dir)) as string | undefined;
        if (!cwd) throw new Error("Não achei a pasta do item para rodar a prova (worktree e pasta não existem).");
        const timeoutMs = Math.min(Math.max(Number(args.timeout_s ?? 300), 10), 1800) * 1000;
        const prova = rodarProva(String(args.comando), cwd, timeoutMs);
        recordEvent(db, s.id, "work_item.proof", {
          id: current.id,
          comando: args.comando,
          ok: prova.ok,
        });
        if (!prova.ok) {
          throw new Error(
            `Entrega recusada: a validação falhou, o item continua com você.\n${prova.resumo}\nCorrija e entregue de novo.`
          );
        }
        validacao = `${args.validacao}\n${prova.resumo}`;
      } else {
        validacao = `${args.validacao}\nprova: nenhuma (relato do autor, não verificado pelo AgentDesk)`;
      }

      const item = updateWorkItemStatus(db, args.work_item_id, "review", {
        delivery_summary: args.resumo,
        validation_summary: validacao,
      });
      let released = 0;
      if (args.manter_travas !== true) released = releaseLocks(db, s.id).released.length;
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "decisao",
        message: `ENTREGUE para review work item ${item.id}: ${args.resumo}. Validação: ${validacao}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "work_item.delivered", { id: item.id, released });
      const next = autoClaimNext(db, s, ag);
      return text([
        `Entregue: ${item.id} -> review assíncrono. Travas liberadas: ${released}.`,
        args.comando ? `prova: ${args.comando} passou (exit 0).` : "prova: nenhuma; o revisor verá que não foi verificado.",
        next
          ? `Próximo item assumido sem espera: ${next.id} · ${next.title}`
          : "Fila pronta vazia; continue em auto.",
      ].join("\n"));
    },
  },

  {
    name: "revisar_tarefa",
    description:
      "Revisão assíncrona por gerente ou por qualquer par da mesma equipe que não seja o autor. Não exige cargo fixo de QA.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        aprovado: { type: "boolean" },
        validacao: { type: "string" },
      },
      required: ["session_id", "work_item_id", "aprovado", "validacao"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const current = getWorkItem(db, args.work_item_id);
      if (!current) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
      if (!ag || current.team_key !== teamKeyForSession(s, ag)) {
        throw new Error("A revisão deve ser feita por um agente da mesma equipe.");
      }
      if (!isManagerAgent(ag) && current.owner_agent_id === ag.id) {
        throw new Error("O autor não pode revisar a própria entrega; qualquer outro par da equipe pode.");
      }
      // Só items em review podem ser revisados (evita aprovar item ainda em
      // working ou já done).
      if (current.status !== "review") {
        throw new Error(
          `Work item ${current.id} está em status ${current.status}; só items em 'review' podem ser revisados.`
        );
      }
      const item = updateWorkItemStatus(db, args.work_item_id, args.aprovado ? "done" : "blocked", {
        validation_summary: args.validacao,
        blocked_reason: args.aprovado ? null : args.validacao,
      });
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: args.aprovado ? "decisao" : "alerta",
        to: item.owner_agent_name,
        message: `${args.aprovado ? "APROVADO" : "REPROVADO"} work item ${item.id}: ${args.validacao}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "work_item.reviewed", { id: item.id, approved: args.aprovado });
      return text([
        `Review registrado:`,
        formatWorkItem(item),
        args.aprovado && item.branch_name
          ? `proximo_passo: chame integrar_tarefa para empurrar a branch e abrir o PR deste item.`
          : "",
      ].filter(Boolean).join("\n"));
    },
  },

  {
    name: "integrar_tarefa",
    description:
      "Fecha o ciclo de um item aprovado: commita o que está na worktree dele, empurra a branch e abre o PR. Nunca faz merge: quem decide o que entra na branch principal é a pessoa.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        mensagem: { type: "string", description: "Título do commit e do PR. Padrão: o título do item." },
        enviar: { type: "boolean", default: true, description: "Empurra a branch para o origin." },
        abrir_pr: { type: "boolean", default: true, description: "Abre o PR com gh (precisa de gh instalado e autenticado)." },
        refazer: { type: "boolean", default: false, description: "Integra de novo um item que já tem integração registrada." },
      },
      required: ["session_id", "work_item_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      const current = getWorkItem(db, args.work_item_id);
      if (!current) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
      if (!ag || current.team_key !== teamKeyForSession(s, ag)) {
        throw new Error("Work item pertence a outra equipe.");
      }
      // Só integra o que já passou pela revisão: empurrar branch de item ainda
      // em execução enche o repositório de trabalho pela metade.
      if (current.status !== "done") {
        throw new Error(
          `Work item ${current.id} está em ${current.status}; só item aprovado na revisão (done) é integrado.`
        );
      }
      if (current.integration_url && !args.refazer) {
        return text(`Este item já foi integrado: ${current.integration_url}. Use refazer=true para integrar de novo.`);
      }
      if (!current.worktree_path || !current.branch_name) {
        throw new Error(
          `Work item ${current.id} não tem worktree própria (o trabalho foi feito direto na pasta). ` +
            `Integre manualmente ou refaça o item com worktree.`
        );
      }

      const titulo = String(args.mensagem ?? current.title).trim();
      const corpo = [
        current.delivery_summary ? `O que foi feito: ${current.delivery_summary}` : null,
        current.validation_summary ? `\nValidação:\n${current.validation_summary}` : null,
        current.acceptance ? `\nCritério de aceite: ${current.acceptance}` : null,
        `\nItem ${current.id} do AgentDesk, executado por ${current.owner_agent_name ?? "—"}.`,
      ].filter(Boolean).join("\n");

      const resultado = integrarWorktree({
        worktreePath: current.worktree_path,
        branch: current.branch_name,
        titulo,
        corpo,
        enviar: args.enviar !== false,
        abrirPr: args.abrir_pr !== false,
      });

      if (resultado.pr_url) {
        db.prepare("UPDATE work_items SET integration_url = ?, integrated_at = ?, updated_at = ? WHERE id = ?")
          .run(resultado.pr_url, now(), now(), current.id);
      } else if (resultado.enviada) {
        db.prepare("UPDATE work_items SET integration_url = ?, integrated_at = ?, updated_at = ? WHERE id = ?")
          .run(`branch ${resultado.branch} enviada`, now(), now(), current.id);
      }

      recordEvent(db, s.id, "work_item.integrated", {
        id: current.id,
        branch: resultado.branch,
        commit: resultado.commit,
        pr_url: resultado.pr_url,
      });
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "decisao",
        message:
          `INTEGRADO ${current.id}: branch ${resultado.branch}` +
          (resultado.pr_url ? ` · PR ${resultado.pr_url}` : resultado.enviada ? " (sem PR)" : " (só local)"),
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });

      return text([
        `Integrado: ${current.id}`,
        `branch: ${resultado.branch}${resultado.enviada ? " (enviada)" : " (não enviada)"}`,
        resultado.commit ? `commit: ${resultado.commit} · ${resultado.arquivos.length} arquivo(s)` : "commit: nada novo a commitar",
        resultado.pr_url ? `PR: ${resultado.pr_url}` : "PR: não aberto",
        ...resultado.avisos.map((aviso) => `aviso: ${aviso}`),
        "O merge continua com a pessoa: o AgentDesk não junta nada sozinho.",
      ].join("\n"));
    },
  },

  // ─── Autonomia (loop) ─────────────────────────────────────────────────────

  {
    name: "tick_autonomo",
    description:
      "Pulso compacto e ativo do loop: lê somente deltas, assume atomicamente o próximo item pronto, adota o papel escolhido pelo gerente e retorna uma única próxima ação. O modo detalhado é opcional.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        modo: { type: "string", enum: ["compacto", "detalhado"], default: "compacto" },
        auto_assumir: { type: "boolean", default: true },
        marcar_processado: { type: "boolean", default: true, description: "Avança o cursor apenas até as mensagens retornadas." },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      if (!ag) throw new Error("Esta sessão não tem agente vinculado. Reabra com abrir.");

      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      touchAgent(db, ag.id);
      const teamKey = teamKeyForSession(s, ag);
      const isGerente = isManagerAgent(ag);
      const current = args.auto_assumir === false ? null : autoClaimNext(db, s, ag);

      const since = ag.last_seen_ms || ag.created_at;
      const newMsgs = db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE team_key = ? AND created_at > ?
             AND agent_id IS NOT ?
             AND (
               to_target = ? OR to_target = ?
               OR (
                 EXISTS (SELECT 1 FROM agents sender WHERE sender.id = chat_messages.agent_id AND sender.authority = 'manager')
                 AND (type IN ('alerta','passar') OR to_target IS NULL)
               )
               OR role = 'dono' OR session_id = 'desktop-owner'
               OR (? = 1 AND to_target IS NULL)
             )
           ORDER BY created_at ASC LIMIT 20`
        )
        .all(teamKey, since, ag.id, ag.name, ag.role, isGerente ? 1 : 0) as any[];

      if (newMsgs.length) {
        const maxTs = newMsgs[newMsgs.length - 1].created_at;
        db.prepare("UPDATE agents SET tick_cursor_ms = ? WHERE id = ?").run(maxTs, ag.id);
        if (args.marcar_processado !== false) markAgentSeen(db, ag.id, maxTs);
      }

      const handoffs = db
        .prepare(
          `SELECT h.*, s2.name as from_name FROM handoffs h
           LEFT JOIN sessions s2 ON s2.id = h.from_session
           WHERE h.team_key = ? AND h.accepted = 0
             AND (h.to_target = ? OR h.to_target = ?)
           ORDER BY h.created_at ASC LIMIT 10`
        )
        .all(teamKey, ag.name, ag.role) as any[];

      const myLocks = db
        .prepare("SELECT file_path FROM locks WHERE session_id = ? AND released_at IS NULL")
        .all(s.id) as { file_path: string }[];
      const working = current ?? (db.prepare(
        `SELECT * FROM work_items WHERE team_key = ? AND owner_agent_id = ? AND status = 'working'
         ORDER BY updated_at DESC LIMIT 1`
      ).get(teamKey, ag.id) as WorkItemRow | undefined) ?? null;
      const intended = working ? parseJsonList(working.intended_files) : parseJsonList(s.intended_files);
      const conflicts = intended.length ? detectConflicts(db, s.id, intended) : [];
      const summary = db.prepare(
        `SELECT
           SUM(status = 'queued') AS queued,
           SUM(status = 'working') AS working,
           SUM(status = 'blocked') AS blocked,
           SUM(status = 'review') AS review
         FROM work_items WHERE team_key = ?`
      ).get(teamKey) as { queued: number | null; working: number | null; blocked: number | null; review: number | null };

      const urgent = newMsgs.some((message) => message.type === "alerta" || message.type === "pedir");
      let action: string;
      let nextDelaySec: number;
      if (working) {
        action = conflicts.length
          ? `RESOLVER_LOCK_OU_BLOQUEAR ${working.id}`
          : `EXECUTAR ${working.id}`;
        nextDelaySec = 30;
      } else if (urgent || handoffs.length) {
        action = "RESPONDER_E_SEGUIR";
        nextDelaySec = 20;
      } else if (isGerente && (summary.blocked || summary.review)) {
        action = `DESTRAVAR_ASSINCRONO blocked=${summary.blocked ?? 0} review=${summary.review ?? 0}`;
        nextDelaySec = 30;
      } else if (isGerente) {
        action = "AGUARDAR_LISTA_OU_EVENTO";
        nextDelaySec = 60;
      } else if (summary.queued) {
        action = "AGUARDAR_DEPENDENCIA_OU_ATRIBUICAO";
        nextDelaySec = 45;
      } else {
        action = "OCIOSO_SEM_BLOQUEAR";
        nextDelaySec = 120;
      }

      const lines = [
        `TICK ${ag.name}/${ag.role} · ${isGerente ? "gerente" : "trabalhador"}`,
        `acao: ${action}`,
        `fila: queued=${summary.queued ?? 0} working=${summary.working ?? 0} blocked=${summary.blocked ?? 0} review=${summary.review ?? 0}`,
        `inbox: ${newMsgs.length} · handoffs: ${handoffs.length} · locks: ${myLocks.length}`,
      ];
      if (working) {
        lines.push(`item: ${working.id} [${working.priority}] ${working.title}`);
        if (working.description) lines.push(`contexto: ${working.description}`);
        if (working.acceptance) lines.push(`aceite: ${working.acceptance}`);
        if (intended.length) lines.push(`escopos: ${intended.join(", ")}`);
        if (working.worktree_path) lines.push(`worktree: ${working.worktree_path}`);
      }
      for (const message of newMsgs.slice(0, args.modo === "detalhado" ? 20 : 5)) {
        lines.push(`msg: ${formatChatLine(message)}`);
      }
      if (args.modo === "detalhado") {
        for (const handoff of handoffs) lines.push(`handoff: ${handoff.from_name ?? handoff.from_session} -> ${handoff.note}`);
        for (const conflict of conflicts) lines.push(`conflito: ${conflict.file} <- ${conflict.held_by_name}/${conflict.held_by_role}`);
      }
      lines.push(`proximo_tick: ${nextDelaySec}s`);
      lines.push("politica: decida sozinho o reversível; bloqueie só impedimento externo/irreversível e então puxe outro item.");
      return text(lines.join("\n"));
    },
  },

  {
    name: "marcar_lido",
    description:
      "Marca todas as mensagens até agora como já vistas pelo agente. Atualiza agent.last_seen_ms. Use APÓS tick_autonomo (ou inbox_agente) para não re-processar os mesmos itens no próximo loop.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        until_ts: { type: "number", description: "Opcional — default Date.now()." },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      if (!ag) throw new Error("Sessão sem agente.");
      // Default: usa o cursor seguro salvo pelo último tick_autonomo (em vez de now()).
      // Isso garante que mensagens entre tick e marcar_lido NÃO são marcadas como lidas
      // sem terem sido processadas pelo agente.
      const cursor = ag.tick_cursor_ms || 0;
      const until = args.until_ts ?? (cursor > 0 ? cursor : now());
      markAgentSeen(db, ag.id, until);
      return text(`Marcado lido até ${new Date(until).toISOString().replace("T", " ").slice(0, 19)} para ${ag.name}.`);
    },
  },

  {
    name: "entrar_modo_auto",
    description:
      "Marca a sessão atual como rodando em modo autônomo (auto_mode=1). Também grava o TMUX_PANE no agente, pra o watcher externo poder empurrar notificações. Passe tmux_pane explicitamente (valor de $TMUX_PANE obtido via Bash) para garantir que o watcher funcione — env do processo MCP nem sempre herda a variável.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        ligar: { type: "boolean", default: true },
        tmux_pane: { type: "string", description: "Valor de $TMUX_PANE da pane atual (ex: %42). Passa explicitamente via Bash pra garantir que o watcher consiga te empurrar." },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      if (!ag) throw new Error("Sessão sem agente.");

      const ligando = args.ligar !== false;

      // Idempotente: se já está no estado pedido, não faz nada — evita reiniciar loop.
      if (ligando && ag.auto_mode === 1) {
        return text(
          `Modo autônomo já estava ATIVO para ${ag.name}. Loop continua rodando — não reinicie.\n` +
            `tmux_pane: ${ag.tmux_pane ?? "(sem pane)"}`
        );
      }
      if (!ligando && ag.auto_mode === 0) {
        return text(`Modo autônomo já estava DESLIGADO para ${ag.name}.`);
      }

      const pane = args.tmux_pane || envTmuxPane();
      setAgentAutoMode(db, ag.id, ligando, pane);
      const status = ligando ? "ATIVO" : "DESLIGADO";
      return text(
        `Modo autônomo ${status} para ${ag.name}.\n` +
          `tmux_pane: ${pane ?? "(sem pane — watcher externo não vai conseguir te empurrar)"}`
      );
    },
  },

  // ─── Restauração de contexto ─────────────────────────────────────────────

  {
    name: "restaurar_contexto",
    description:
      "Reconstrói o contexto completo de um agente a partir do banco de dados — quem era, o que estava fazendo, últimos progressos, inbox não lido, travas, time. Use após reiniciar o Claude Code para retomar exatamente de onde parou sem precisar da conversa anterior.",
    inputSchema: {
      type: "object",
      properties: {
        cargo: { type: "string", description: "Papel atual do agente a restaurar (compatibilidade)." },
        pasta: { type: "string", description: "Pasta de trabalho (ajuda a identificar o agente certo se houver múltiplos do mesmo cargo)." },
        preferred_name: { type: "string", description: "Nome do agente, se souber." },
      },
      required: ["cargo"],
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);

      // Encontra o agente.
      let agent: AgentRow | null = null;
      if (args.preferred_name) {
        agent = findAgentByName(db, args.preferred_name);
      }
      if (!agent) {
        let matches = findMatchingAgents(db, args.cargo, args.pasta);
        if (matches.length === 0 && args.pasta) {
          matches = findMatchingAgents(db, args.cargo, args.pasta, { anyFolder: true });
        }
        if (matches.length === 1) {
          agent = matches[0];
        } else if (matches.length > 1) {
          agent = matches.sort((a, b) => b.updated_at - a.updated_at)[0];
        }
      }
      if (!agent) {
        return text(`Nenhum agente encontrado para cargo=${args.cargo} pasta=${args.pasta || "—"}. Rode /abrir para criar.`);
      }

      const lines: string[] = [];
      const sep = "═".repeat(50);
      lines.push(sep);
      lines.push(`CONTEXTO RESTAURADO — ${agent.name}/${agent.role}`);
      lines.push(sep);
      lines.push(`agent_id: ${agent.id}`);
      lines.push(`status: ${agent.status}  auto_mode: ${agent.auto_mode ? "ligado" : "desligado"}`);
      lines.push("");

      // Sessão atual.
      const session = agent.current_session_id
        ? (db.prepare("SELECT * FROM sessions WHERE id = ?").get(agent.current_session_id) as any)
        : null;
      if (session) {
        lines.push(`SESSÃO: ${session.name} (id=${session.id})`);
        lines.push(`session_id: ${session.id}  ← copie este valor`);
        lines.push(`STATUS: ${session.status}`);
        lines.push(`TAREFA: ${session.task || "(sem tarefa)"}`);
      } else {
        lines.push("SESSÃO: nenhuma ativa. Rode /abrir para criar.");
      }
      lines.push("");

      // Última task.
      const task = agent.current_task_id
        ? (db.prepare("SELECT * FROM tasks WHERE id = ?").get(agent.current_task_id) as any)
        : null;
      if (task) {
        lines.push(`TAREFA ATIVA (task_id=${task.id}): ${task.title} [${task.status}]`);
      }

      // Último progresso.
      if (agent.progress_summary) {
        lines.push(`ÚLTIMO PROGRESSO: ${agent.progress_summary}`);
      }

      // Últimos 5 updates.
      const updates = session
        ? (db
            .prepare(
              "SELECT progress, created_at FROM updates WHERE session_id = ? ORDER BY created_at DESC LIMIT 5"
            )
            .all(session.id) as any[])
        : [];
      if (updates.length) {
        lines.push("");
        lines.push("HISTÓRICO RECENTE:");
        for (const u of updates.reverse()) {
          const t = new Date(u.created_at).toISOString().replace("T", " ").slice(0, 16);
          lines.push(`  [${t}] ${u.progress}`);
        }
      }

      // Inbox não lido.
      const since = agent.last_seen_ms || agent.created_at;
      const inbox = db
        .prepare(
          `SELECT cm.* FROM chat_messages cm
           WHERE cm.team_key = ? AND created_at > ?
             AND agent_id IS NOT ?
             AND (
               to_target = ? OR to_target = ?
               OR (
                 EXISTS (SELECT 1 FROM agents sender WHERE sender.id = cm.agent_id AND sender.authority = 'manager')
                 AND (type = 'alerta' OR to_target IS NULL)
               )
               OR cm.role = 'dono' OR cm.session_id = 'desktop-owner'
               OR (? = 1 AND to_target IS NULL)
             )
           ORDER BY created_at ASC LIMIT 20`
        )
        .all(agent.team_key, since, agent.id, agent.name, agent.role, isManagerAgent(agent) ? 1 : 0) as any[];
      lines.push("");
      lines.push(`INBOX NÃO LIDO (${inbox.length}):`);
      if (!inbox.length) {
        lines.push("  (nenhuma mensagem pendente)");
      } else {
        for (const m of inbox) lines.push("  " + formatChatLine(m));
      }

      // Travas ativas.
      const locks = session
        ? (db
            .prepare("SELECT file_path FROM locks WHERE session_id = ? AND released_at IS NULL")
            .all(session.id) as { file_path: string }[])
        : [];
      lines.push("");
      lines.push(`TRAVAS ATIVAS (${locks.length}):`);
      if (!locks.length) {
        lines.push("  (nenhuma)");
      } else {
        for (const l of locks) lines.push(`  ✓ ${l.file_path}`);
      }

      // Time ativo.
      lines.push("");
      lines.push("TIME ATIVO:");
      lines.push(renderTeamContext(db));

      lines.push("");
      lines.push(sep);
      if (session) {
        lines.push(`✓ Pronto. Use session_id=${session.id} nos próximos comandos.`);
        lines.push("  Se estava em /auto, rode /auto para retomar o loop.");
      } else {
        lines.push("⚠ Sem sessão ativa — rode /abrir para reconectar.");
      }

      return text(lines.join("\n"));
    },
  },

  // ─── Delegação (gerente mestre) ──────────────────────────────────────────

  {
    name: "delegar_tarefa",
    description:
      "Compatibilidade: gerente delega um item individual a um agente ou papel atual. Para listas, use distribuir_tarefas.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id do gerente." },
        para: { type: "string", description: "Nome do agente ou papel atual livre." },
        tarefa: { type: "string", description: "Descrição clara e acionável do que deve ser feito." },
        contexto: { type: "string", description: "Contexto adicional, dependências, critério de aceite." },
        prioridade: { type: "string", enum: ["normal", "alta", "critica"], default: "normal" },
      },
      required: ["session_id", "para", "tarefa"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      const ag = getManagerForSession(db, s);
      const ts = now();

      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(ts, s.id);
      if (ag) touchAgent(db, ag.id);

      const prioridade = args.prioridade ?? "normal";
      const targetAgent = getAgentByIdentifier(db, args.para);
      if (targetAgent && targetAgent.status === "archived") {
        throw new Error(`Agente ${targetAgent.name} está arquivado — não dá pra delegar pra ele.`);
      }
      if (targetAgent && targetAgent.team_key !== teamKeyForSession(s, ag)) {
        throw new Error(`Agente ${targetAgent.name} pertence a outra equipe.`);
      }
      const item = createWorkItem(db, {
        title: args.tarefa,
        description: args.contexto ?? null,
        acceptance: "Destinatário entrega via entregar_tarefa com validação executada ou justificativa.",
        priority: prioridade,
        team_key: teamKeyForSession(s, ag),
        project: s.project ?? null,
        folder: s.folder ?? null,
        assigned_to: targetAgent ? targetAgent.name : null,
        assigned_role: targetAgent ? targetAgent.role : args.para,
        created_by_session: s.id,
        created_by_agent: ag?.name ?? null,
      });
      const prefixo = prioridade === "critica" ? "🚨 CRÍTICO" : prioridade === "alta" ? "⚠️ URGENTE" : "📋 TAREFA";
      const mensagem = [
        `${prefixo} — work item ${item.id} delegado por ${ag?.name ?? s.name}/${s.role}`,
        ``,
        args.tarefa,
        args.contexto ? `\nContexto: ${args.contexto}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "decisao",
        to: args.para,
        message: mensagem,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
        // Silent: o createWorkItem(item) já emitiu notify pro broker. Não dobra.
        silent: true,
      });

      recordEvent(db, s.id, "task.delegated", { para: args.para, tarefa: args.tarefa, prioridade, work_item_id: item.id });

      return text(
        `Tarefa delegada para ${args.para} [${prioridade}] como work item ${item.id}:\n${args.tarefa}\n\n` +
          `O destinatário verá no inbox no próximo tick (até 60s se em /auto).`
      );
    },
  },
];

export { getSessionByIdentifier };
