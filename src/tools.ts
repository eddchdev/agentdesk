import { z } from "zod";
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
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  parseJsonList,
  updateWorkItemStatus,
  type WorkItemRow,
} from "./work-items.js";
import { prepareWorktree } from "./worktree.js";
import {
  createAgent,
  findMatchingAgents,
  findAgentByName,
  findAgentById,
  getAgentByIdentifier,
  getAgentForSession,
  listAgents,
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

const ROLES = ["gerente", "backend", "frontend", "bugs", "whatsapp", "qa"] as const;

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

function renderTeamContext(db: Database.Database): string {
  sweepSessions(db);
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE status IN ('active','suspect') ORDER BY opened_at ASC")
    .all() as SessionRow[];

  if (!sessions.length) return "Nenhuma sessão ativa no momento.";

  const lines: string[] = ["EQUIPE ATIVA:"];
  for (const s of sessions) {
    const status = deriveStatus(s);
    const areas = parseJsonList(s.areas).join(", ") || "—";
    const files = parseJsonList(s.intended_files).join(", ") || "—";
    lines.push(
      `- ${s.name} [${s.role}] status=${status}
    tarefa: ${s.task ?? "—"}
    projeto: ${s.project ?? "—"}  pasta: ${s.folder ?? "—"}
    áreas: ${areas}
    arquivos pretendidos: ${files}`
    );
  }
  return lines.join("\n");
}

function renderLocks(db: Database.Database): string {
  const locks = activeLocks(db);
  if (!locks.length) return "Sem travas ativas.";
  const lines = ["TRAVAS ATIVAS:"];
  for (const l of locks) {
    lines.push(`- ${l.file_path}  ←  ${l.session_name} [${l.session_role}]${l.area ? ` (área: ${l.area})` : ""}`);
  }
  return lines.join("\n");
}

function renderTasks(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT t.*, s.name as session_name FROM tasks t
       JOIN sessions s ON s.id = t.session_id
       WHERE t.status IN ('in_progress','pending') ORDER BY t.updated_at DESC LIMIT 20`
    )
    .all() as Array<{ id: string; title: string; status: string; session_name: string }>;
  if (!rows.length) return "Sem tarefas em aberto.";
  const lines = ["TAREFAS EM ABERTO:"];
  for (const t of rows) lines.push(`- [${t.status}] ${t.session_name}: ${t.title}`);
  return lines.join("\n");
}

function renderWorkItems(db: Database.Database): string {
  const rows = listWorkItems(db, { limit: 12 }).filter((w) => !["done", "canceled"].includes(w.status));
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
    w.branch_name ? `branch: ${w.branch_name}` : null,
  ].filter(Boolean).join("\n");
}

function renderRecentChat(db: Database.Database, limit = 10): string {
  const rows = listChat(db, { limit });
  if (!rows.length) return "Chat vazio.";
  const lines = ["ÚLTIMAS MENSAGENS:"];
  for (const r of rows.reverse()) lines.push(formatChatLine(r));
  return lines.join("\n");
}

function renderAgents(db: Database.Database): string {
  const agents = listAgents(db);
  if (!agents.length) return "Nenhum agente registrado.";
  const lines = ["AGENTES:"];
  for (const a of agents) {
    const session = a.current_session_id
      ? (db.prepare("SELECT name, status, last_heartbeat FROM sessions WHERE id = ?").get(a.current_session_id) as
          | { name: string; status: string; last_heartbeat: number }
          | undefined)
      : null;
    const sess = session ? `sessão=${session.name} (${session.status})` : "sessão=—";
    lines.push(`- ${a.name} [${a.role}] status=${a.status}  ${sess}`);
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
}

function openSession(db: Database.Database, p: OpenSessionInput): { sessionId: string; sessionName: string; taskId: string; ts: number } {
  const id = newId();
  const ts = now();
  const sessionStmt = db.prepare(
    `INSERT INTO sessions
     (id, name, role, task, project, folder, areas, intended_files, opened_at, last_heartbeat, status, agent_id, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  );

  // Race-safe: nome único pra sessão. Se outro processo inseriu mesmo nome
  // entre o pickSessionName e o INSERT, retry com próximo número.
  let name = pickSessionName(db, p.cargo);
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
        p.agent?.name ?? null
      );
      break;
    } catch (e: any) {
      if (!/UNIQUE.*sessions\.name/i.test(e?.message ?? "") || attempts++ >= 10) throw e;
      // Tenta um nome novo (incrementa ou adiciona sufixo random no final).
      name = pickSessionName(db, p.cargo);
    }
  }
  const taskId = newId();
  db.prepare(
    `INSERT INTO tasks (id, session_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`
  ).run(taskId, id, p.tarefa, p.tarefa, ts, ts);

  if (p.agent) {
    setAgentStatus(db, p.agent.id, "working", { current_session_id: id, current_task_id: taskId });
    touchAgent(db, p.agent.id);
  }
  return { sessionId: id, sessionName: name, taskId, ts };
}

// Ressuscita uma sessão dead (sem fechar e reabrir). Só cria task nova se a tarefa mudou.
function reopenSession(
  db: Database.Database,
  sessionId: string,
  newTask: string,
  agent: AgentRow
): { sessionId: string; sessionName: string; taskId: string; ts: number } {
  const ts = now();
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
  db.prepare(
    "UPDATE sessions SET last_heartbeat = ?, status = 'active', task = ? WHERE id = ?"
  ).run(ts, newTask, sessionId);

  const taskId = newId();
  db.prepare(
    `INSERT INTO tasks (id, session_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`
  ).run(taskId, sessionId, newTask, newTask, ts, ts);

  setAgentStatus(db, agent.id, "working", { current_session_id: sessionId, current_task_id: taskId });
  touchAgent(db, agent.id);

  return { sessionId, sessionName: session.name, taskId, ts };
}

function getAgentByActiveSession(db: Database.Database, sessionId: string): AgentRow | null {
  return getAgentForSession(db, sessionId);
}

function renderInbox(db: Database.Database, agent: AgentRow, since: number): string {
  // Mensagens para este agente (por nome ou por cargo) + handoffs pendentes desde 'since'.
  const msgs = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE created_at > ?
         AND (
           to_target = ? OR to_target = ?
           OR (role = 'gerente' AND (type = 'alerta' OR to_target IS NULL))
           OR role = 'dono'
         )
       ORDER BY created_at ASC LIMIT 50`
    )
    .all(since, agent.name, agent.role) as any[];

  const handoffs = db
    .prepare(
      `SELECT h.*, s.name as from_name FROM handoffs h
       LEFT JOIN sessions s ON s.id = h.from_session
       WHERE h.accepted = 0
         AND (h.to_target = ? OR h.to_target = ?)
       ORDER BY h.created_at ASC LIMIT 20`
    )
    .all(agent.name, agent.role) as any[];

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

// ─────────────────────────────────────────────────────────────────────────────

export const tools: ToolDef[] = [
  {
    name: "abrir_sessao",
    description:
      "Abre uma nova sessão da equipe AgentDesk. Use no início de toda sessão do Claude Code, antes de qualquer coisa. Recebe cargo, tarefa, projeto, pasta e áreas/arquivos pretendidos. Retorna o session_id e o contexto da equipe.",
    inputSchema: {
      type: "object",
      properties: {
        cargo: { type: "string", enum: [...ROLES], description: "Cargo desta sessão." },
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
      },
      required: ["cargo", "tarefa"],
    },
    handler: (args) => {
      const schema = z.object({
        cargo: z.enum(ROLES as any),
        tarefa: z.string().min(1),
        projeto: z.string().optional().default(""),
        pasta: z.string().optional().default(""),
        areas: z.array(z.string()).optional().default([]),
        arquivos_pretendidos: z.array(z.string()).optional().default([]),
      });
      const p = schema.parse(args);
      const db = getDb();
      sweepSessions(db);

      // Legacy: cria sempre agente novo (sem retomada). Pra retomada use abrir_ou_retornar_agente.
      const agentName = pickUniqueName(db);
      const agent = createAgent(db, {
        name: agentName,
        role: p.cargo,
        project: p.projeto,
        folder: p.pasta,
        tmux_pane: envTmuxPane(),
      });

      const { sessionId, sessionName, taskId } = openSession(db, {
        cargo: p.cargo,
        tarefa: p.tarefa,
        projeto: p.projeto,
        pasta: p.pasta,
        areas: p.areas,
        arquivos_pretendidos: p.arquivos_pretendidos,
        agent,
      });

      recordEvent(db, sessionId, "session.opened", { name: sessionName, role: p.cargo, task: p.tarefa, agent: agentName });
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
          `Cargo: ${p.cargo}`,
          `Tarefa: ${p.tarefa}`,
          `Pasta: ${p.pasta || "—"}`,
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
      "Mostra a equipe ativa, status (active/suspect/dead), travas de arquivo, tarefas em aberto e últimas mensagens. Use sempre antes de começar a trabalhar e periodicamente.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Opcional — atualiza heartbeat se informado." },
      },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      if (args?.session_id) {
        try {
          requireActiveSession(db, args.session_id);
          db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), args.session_id);
        } catch {
          /* ignore */
        }
      }
      const out = [
        renderAgents(db),
        "",
        renderTeamContext(db),
        "",
        renderWorkItems(db),
        "",
        renderLocks(db),
        "",
        renderTasks(db),
        "",
        renderRecentChat(db, 12),
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
      "Pede uma ação a outro Claude ou a um cargo (mensagem tipo 'pedir'). Informe o destinatário (nome da sessão ou cargo) e a mensagem.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        destinatario: {
          type: "string",
          description: "Nome da sessão (ex: AgentDesk-Backend-01) ou cargo (ex: backend).",
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
      "Passa (handoff) uma tarefa para outro Claude ou cargo. Registra a transferência e libera as travas da tarefa.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task_id: { type: "string", description: "ID da tarefa a passar (opcional: usa a principal se omitido)." },
        destinatario: { type: "string", description: "Nome da sessão ou cargo de destino." },
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

      const ts = now();
      const hid = newId();
      db.prepare(
        "INSERT INTO handoffs (id, from_session, to_target, task_id, note, created_at, accepted) VALUES (?, ?, ?, ?, ?, ?, 0)"
      ).run(hid, s.id, args.destinatario, taskId, args.nota, ts);
      notify({
        kind: "handoff",
        to: args.destinatario,
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
        message: `Passando tarefa: ${args.nota}`,
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
      "Libera travas. Sem 'arquivos', libera todas as suas. Com 'forcar=true' e cargo gerente, força liberação de qualquer trava.",
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
      const r = releaseLocks(db, s.id, args.arquivos, args.forcar, s.role);
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
      "Lista mensagens recentes do chat da equipe. Pode filtrar por destinatário, tipo, e quantidade.",
    inputSchema: {
      type: "object",
      properties: {
        limite: { type: "number", default: 30 },
        para: { type: "string", description: "Filtra por destinatário (nome de sessão ou cargo)." },
        tipo: { type: "string", enum: ["falar", "pedir", "passar", "alerta", "decisao", "erro"] },
        desde_ts: { type: "number", description: "timestamp ms para filtrar mensagens posteriores." },
      },
    },
    handler: (args) => {
      const db = getDb();
      const rows = listChat(db, {
        limit: args?.limite ?? 30,
        to: args?.para ?? null,
        type: args?.tipo as ChatType | undefined,
        since: args?.desde_ts,
      });
      if (!rows.length) return text("Sem mensagens.");
      return text(rows.reverse().map(formatChatLine).join("\n"));
    },
  },

  {
    name: "listar_contexto_time",
    description:
      "Retorna o snapshot completo do contexto da equipe: sessões ativas, tarefas, travas, últimas decisões e progresso. Use antes de começar trabalho novo.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Opcional — atualiza heartbeat." },
      },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      if (args?.session_id) {
        try {
          requireActiveSession(db, args.session_id);
          db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), args.session_id);
        } catch {
          /* ignore */
        }
      }

      const recentDecisions = db
        .prepare(
          "SELECT * FROM chat_messages WHERE type IN ('decisao','alerta') ORDER BY created_at DESC LIMIT 10"
        )
        .all() as any[];
      const lastUpdates = db
        .prepare(
          `SELECT u.*, s.name as session_name, s.role as session_role
           FROM updates u JOIN sessions s ON s.id = u.session_id
           ORDER BY u.created_at DESC LIMIT 10`
        )
        .all() as any[];

      const out: string[] = [];
      out.push(renderAgents(db));
      out.push("");
      out.push(renderTeamContext(db));
      out.push("");
      out.push(renderTasks(db));
      out.push("");
      out.push(renderWorkItems(db));
      out.push("");
      out.push(renderLocks(db));
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
      out.push(renderRecentChat(db, 15));

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
    name: "abrir_ou_retornar_agente",
    description:
      "Abre uma sessão para um AGENTE PERSISTENTE. Se já existir agente do mesmo cargo + pasta com status available/paused/dead, retoma automaticamente. Se houver múltiplos candidatos, lista. Caso contrário, cria agente novo com nome humano persistente. Esta é a entrada PREFERIDA — use no lugar de abrir_sessao.",
    inputSchema: {
      type: "object",
      properties: {
        cargo: { type: "string", enum: [...ROLES] },
        tarefa: { type: "string", description: "Opcional em retomada — se omitida, mantém a tarefa anterior do agente." },
        projeto: { type: "string" },
        pasta: { type: "string", description: "Pasta de trabalho (chave de match com agentes existentes)." },
        areas: { type: "array", items: { type: "string" } },
        arquivos_pretendidos: { type: "array", items: { type: "string" } },
        preferred_name: { type: "string", description: "Se preencher, tenta retomar agente com esse nome." },
        force_new: { type: "boolean", default: false, description: "Ignora match, cria agente novo." },
        retomar_agente_id: { type: "string", description: "ID de agente específico a retomar." },
        tmux_pane: { type: "string", description: "Valor de $TMUX_PANE da pane atual (ex: %42). Passa explicitamente via Bash." },
      },
      required: ["cargo"],
    },
    handler: (args) => {
      const schema = z.object({
        cargo: z.enum(ROLES as any),
        tarefa: z.string().optional(),
        projeto: z.string().optional().default(""),
        pasta: z.string().optional().default(""),
        areas: z.array(z.string()).optional().default([]),
        arquivos_pretendidos: z.array(z.string()).optional().default([]),
        preferred_name: z.string().optional(),
        force_new: z.boolean().optional().default(false),
        retomar_agente_id: z.string().optional(),
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
        effectiveFolder = process.env.AGENTDESK_FOLDER || "";
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
          project: p.projeto,
          folder: p.pasta,
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
            pasta: p.pasta,
            areas: p.areas,
            arquivos_pretendidos: p.arquivos_pretendidos,
            agent,
          });

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
      const inbox = renderInbox(db, agent, since);
      const ctx = renderTeamContext(db);

      // Restauração de contexto (só em modo resumed): progresso anterior + tarefa em andamento + últimos updates
      const restoreLines: string[] = [];
      if (mode === "resumed") {
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
          `Cargo: ${p.cargo}  Pasta: ${p.pasta || "—"}`,
          "",
          ...restoreLines,
          "── INBOX ──",
          inbox,
          "",
          "── TIME ──",
          ctx,
          "",
          "Guarde agent_id e session_id. Próximos comandos:",
          "  /status, /inbox, /falar, /pedir, /travar, /atualizar, /feito, /fechar",
        ].join("\n")
      );
    },
  },

  {
    name: "listar_agentes",
    description: "Lista todos os agentes (com nome, cargo, status, tarefa atual, última atividade). Útil pra ver quem está disponível pra retomada.",
    inputSchema: {
      type: "object",
      properties: {
        incluir_arquivados: { type: "boolean", default: false },
      },
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const agents = listAgents(db, { include_archived: !!args?.incluir_arquivados });
      if (!agents.length) return text("Nenhum agente registrado.");
      const lines: string[] = [`Total: ${agents.length} agente(s).`, ""];
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
          `- ${a.name} [${a.role}] status=${a.status} (atualizado ${upd})\n    id: ${a.id}\n    pasta: ${a.folder || "—"}    projeto: ${a.project || "—"}\n    sessão atual: ${sess ? `${sess.name} (${sess.status})` : "—"}\n    tarefa atual: ${task ? `${task.title} [${task.status}]` : "—"}`
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
        cargo: { type: "string", enum: [...ROLES], description: "Opcional — sobrescreve o cargo." },
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
      return text(`Agente ${ag.name} pausado. Sessão ${s.name} fechada. Pode ser retomado com /abrir (mesmo cargo+pasta) ou retomar_agente.`);
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
      return text(`Agente ${ag.name} arquivado. Histórico preservado.`);
    },
  },

  {
    name: "inbox_agente",
    description:
      "Retorna o que está pendente para o agente da sessão atual: pedidos direcionados (por nome ou por cargo), alertas críticos do gerente e handoffs pendentes — tudo desde o último heartbeat conhecido do agente.",
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
        para: { type: "string", description: "Nome do agente ou cargo alvo." },
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
      // Valida: se 'para' foi passado, deve ser cargo válido OU agente vivo.
      // Antes: aceitava qualquer string e a tarefa ficava "no vazio".
      if (target && !targetAgent && !ROLES.includes(target as any)) {
        throw new Error(
          `'para'='${target}' não é cargo válido (${ROLES.join(", ")}) nem agente registrado. ` +
            `Use /agentes pra ver opções, ou omita 'para' pra deixar livre.`
        );
      }
      if (targetAgent && targetAgent.status === "archived") {
        throw new Error(
          `Agente ${targetAgent.name} está arquivado. Escolha outro destinatário ou desarquive antes.`
        );
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
        project: args.projeto ?? s.project ?? null,
        folder: args.pasta ?? s.folder ?? null,
        areas: args.areas ?? [],
        intended_files: args.arquivos_ou_escopos ?? [],
        dependencies: args.dependencias ?? [],
        assigned_to: targetAgent ? targetAgent.name : target ?? null,
        assigned_role: targetAgent ? targetAgent.role : target && ROLES.includes(target as any) ? target : null,
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
      "Lista work items estruturados. Pode filtrar por status ou por agente/cargo alvo.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["queued", "claimed", "working", "blocked", "review", "done", "canceled"] },
        para: { type: "string", description: "Nome do agente ou cargo." },
        limite: { type: "number", default: 30 },
      },
    },
    handler: (args) => {
      const db = getDb();
      const rows = listWorkItems(db, { status: args?.status ?? null, assigned: args?.para ?? null, limit: args?.limite ?? 30 });
      if (!rows.length) return text("Nenhum work item encontrado.");
      return text(rows.map(formatWorkItem).join("\n\n"));
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
        });
      } catch (e) {
        // Rollback dos locks que acabamos de pegar — outro agente é o dono.
        if (scopes.length) releaseLocks(db, s.id, scopes);
        throw e;
      }

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

      // Só o dono ou o gerente pode bloquear. Antes: qualquer um podia.
      const isOwner = !!ag && current.owner_agent_id === ag.id;
      const isGerente = s.role === "gerente";
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
      return text(`Work item bloqueado:\n${formatWorkItem(item)}`);
    },
  },

  {
    name: "entregar_tarefa",
    description:
      "Entrega um work item para review. Informe resumo e validação executada (build/test/check ou justificativa).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        work_item_id: { type: "string" },
        resumo: { type: "string" },
        validacao: { type: "string", description: "Comandos/checagens executados ou justificativa se não rodou." },
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

      const item = updateWorkItemStatus(db, args.work_item_id, "review", {
        delivery_summary: args.resumo,
        validation_summary: args.validacao,
      });
      let released = 0;
      if (args.manter_travas !== true) released = releaseLocks(db, s.id).released.length;
      postChat(db, {
        sessionId: s.id,
        sessionName: s.name,
        role: s.role,
        type: "decisao",
        message: `ENTREGUE para review work item ${item.id}: ${args.resumo}. Validação: ${args.validacao}`,
        agentId: ag?.id ?? null,
        agentName: ag?.name ?? null,
      });
      recordEvent(db, s.id, "work_item.delivered", { id: item.id, released });
      return text(`Work item entregue para review. Travas liberadas: ${released}\n${formatWorkItem(item)}`);
    },
  },

  {
    name: "revisar_tarefa",
    description:
      "QA/gerente aprova ou reprova um work item entregue. Aprovação marca done; reprovação volta para blocked com motivo.",
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
      if (!["qa", "gerente"].includes(s.role)) throw new Error("Apenas qa ou gerente deve revisar work items.");
      const current = getWorkItem(db, args.work_item_id);
      if (!current) throw new Error(`Work item ${args.work_item_id} não encontrado.`);
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
      return text(`Review registrado:\n${formatWorkItem(item)}`);
    },
  },

  // ─── Autonomia (loop) ─────────────────────────────────────────────────────

  {
    name: "tick_autonomo",
    description:
      "Snapshot completo do que está PENDENTE pro agente da sessão atual — agregando inbox NOVO (desde last_seen_ms), handoffs, tarefa atual e travas próprias. Usado pelo /loop /auto-tick. Retorna texto estruturado com sugestão de próxima ação e delay até a próxima checagem.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
    handler: (args) => {
      const db = getDb();
      sweepSessions(db);
      const s = requireActiveSession(db, args.session_id);
      const ag = getAgentByActiveSession(db, s.id);
      if (!ag) throw new Error("Esta sessão não tem agente vinculado. Reabra com abrir_ou_retornar_agente.");

      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now(), s.id);
      touchAgent(db, ag.id);

      const since = ag.last_seen_ms || ag.created_at;

      // Mensagens novas direcionadas ao agente (por nome OU por cargo) ou alertas críticos do gerente.
      const newMsgs = db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE created_at > ?
             AND agent_id IS NOT ?
             AND (
               to_target = ? OR to_target = ?
               OR (role = 'gerente' AND (type IN ('alerta','passar') OR to_target IS NULL))
               OR role = 'dono'
               -- Se EU sou gerente, vejo broadcasts de subordinados (resposta sobe)
               OR (? = 'gerente' AND to_target IS NULL AND role NOT IN ('gerente','dono'))
             )
           ORDER BY created_at ASC LIMIT 50`
        )
        .all(since, ag.id, ag.name, ag.role, ag.role) as any[];

      // Cursor seguro pro próximo marcar_lido: max(created_at) das mensagens RETORNADAS.
      // Evita o race onde mensagens chegam entre tick_autonomo e marcar_lido e são
      // marcadas como vistas sem terem sido processadas.
      if (newMsgs.length) {
        const maxTs = newMsgs[newMsgs.length - 1].created_at;
        db.prepare("UPDATE agents SET tick_cursor_ms = ? WHERE id = ?").run(maxTs, ag.id);
      }

      const handoffs = db
        .prepare(
          `SELECT h.*, s2.name as from_name FROM handoffs h
           LEFT JOIN sessions s2 ON s2.id = h.from_session
           WHERE h.accepted = 0
             AND (h.to_target = ? OR h.to_target = ?)
           ORDER BY h.created_at ASC LIMIT 10`
        )
        .all(ag.name, ag.role) as any[];

      // Tarefa atual + último progresso.
      const task = ag.current_task_id
        ? (db.prepare("SELECT * FROM tasks WHERE id = ?").get(ag.current_task_id) as any | undefined)
        : null;
      const lastUpdate = task
        ? (db.prepare("SELECT progress, created_at FROM updates WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id) as any | undefined)
        : null;

      // Travas próprias.
      const myLocks = db
        .prepare("SELECT file_path FROM locks WHERE session_id = ? AND released_at IS NULL")
        .all(s.id) as { file_path: string }[];

      // Conflito potencial: locks de outros agentes nas áreas/arquivos pretendidos.
      const intended = parseJsonList(s.intended_files);
      const conflicts = intended.length ? detectConflicts(db, s.id, intended) : [];
      const workById = new Map<string, WorkItemRow>();
      for (const w of [
        ...listWorkItems(db, { assigned: ag.name, limit: 10 }),
        ...listWorkItems(db, { assigned: ag.role, limit: 10 }),
      ]) {
        if (["queued", "claimed", "working", "blocked", "review"].includes(w.status)) workById.set(w.id, w);
      }
      const myWorkItems = [...workById.values()].sort((a, b) => b.updated_at - a.updated_at);

      const urgentCritical = newMsgs.some(
        (m) => m.type === "alerta" || (m.type === "pedir" && m.role === "gerente")
      );

      // Visão da equipe para gerente: quem está ocioso ou sem progresso recente.
      const isGerente = s.role === "gerente";
      const idleAgents: { name: string; role: string; idle_min: number; last_summary: string | null }[] = [];
      if (isGerente) {
        const teamAgents = db
          .prepare(
            `SELECT a.name, a.role, a.last_heartbeat, a.progress_summary, a.status
             FROM agents a WHERE a.status NOT IN ('archived','dead') AND a.role != 'gerente'`
          )
          .all() as any[];
        const idleThreshold = now() - 5 * 60_000; // 5min sem heartbeat = ocioso
        for (const a of teamAgents) {
          if ((a.last_heartbeat || 0) < idleThreshold) {
            idleAgents.push({
              name: a.name,
              role: a.role,
              idle_min: Math.round((now() - (a.last_heartbeat || 0)) / 60_000),
              last_summary: a.progress_summary,
            });
          }
        }
      }

      let suggestion: "AGIR" | "AGUARDAR" | "OCIOSO";
      let nextDelaySec: number;
      if (urgentCritical || newMsgs.length || handoffs.length || myWorkItems.some((w) => ["queued", "claimed", "blocked"].includes(w.status))) {
        suggestion = "AGIR";
        nextDelaySec = 30;
      } else if (isGerente && idleAgents.length) {
        // Gerente: time ocioso = precisa delegar novas tarefas.
        suggestion = "AGIR";
        nextDelaySec = 30;
      } else if (task && task.status === "in_progress") {
        suggestion = "AGIR";
        nextDelaySec = 60;
      } else if (conflicts.length) {
        suggestion = "AGUARDAR";
        nextDelaySec = 120;
      } else {
        suggestion = "OCIOSO";
        nextDelaySec = isGerente ? 60 : 300; // gerente checa mais rápido
      }

      const lines: string[] = [];
      lines.push(`TICK AUTÔNOMO · ${ag.name}/${ag.role} · ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
      lines.push(`session_id: ${s.id}  agent_id: ${ag.id}`);
      lines.push("");

      lines.push(`INBOX NOVO (${newMsgs.length}):`);
      if (!newMsgs.length) {
        lines.push("  (nada novo desde a última checagem)");
      } else {
        for (const m of newMsgs) lines.push("  " + formatChatLine(m));
      }
      lines.push("");

      lines.push(`HANDOFFS PENDENTES (${handoffs.length}):`);
      if (!handoffs.length) {
        lines.push("  (nenhum)");
      } else {
        for (const h of handoffs) {
          const time = new Date(h.created_at).toISOString().replace("T", " ").slice(0, 19);
          lines.push(`  [${time}] de ${h.from_name ?? h.from_session} -> ${h.to_target}  task=${h.task_id}: ${h.note}`);
        }
      }
      lines.push("");

      lines.push("TAREFA ATUAL:");
      if (!task) {
        lines.push("  (nenhuma)");
      } else {
        lines.push(`  ${task.title} [${task.status}]`);
        if (lastUpdate) {
          const t = new Date(lastUpdate.created_at).toISOString().replace("T", " ").slice(0, 19);
          lines.push(`  último progresso [${t}]: ${lastUpdate.progress}`);
        }
      }
      lines.push("");

      lines.push(`WORK ITEMS PARA MIM (${myWorkItems.length}):`);
      if (!myWorkItems.length) {
        lines.push("  (nenhum)");
      } else {
        for (const w of myWorkItems) {
          lines.push(`  ${w.id} [${w.status}/${w.priority}] ${w.title}`);
          if (w.worktree_path) lines.push(`    worktree: ${w.worktree_path}`);
          if (w.blocked_reason) lines.push(`    bloqueio: ${w.blocked_reason}`);
        }
      }
      lines.push("");

      lines.push(`MEUS LOCKS (${myLocks.length}):`);
      if (myLocks.length) {
        for (const l of myLocks) lines.push(`  ✓ ${l.file_path}`);
      } else {
        lines.push("  (nenhum)");
      }
      if (conflicts.length) {
        lines.push("");
        lines.push("CONFLITOS NOS ARQUIVOS PRETENDIDOS:");
        for (const c of conflicts) lines.push(`  ✗ ${c.file}  ← ${c.held_by_name} [${c.held_by_role}] (${c.status})`);
      }

      if (isGerente) {
        lines.push("");
        lines.push(`EQUIPE OCIOSA (${idleAgents.length}) — candidatos a nova delegação:`);
        if (!idleAgents.length) {
          lines.push("  (todos ativos)");
        } else {
          for (const a of idleAgents) {
            lines.push(`  ⚠ ${a.name}/${a.role}  ocioso há ${a.idle_min}min`);
            if (a.last_summary) lines.push(`    último: ${a.last_summary}`);
          }
        }
      }

      lines.push("");
      lines.push(`SUGESTÃO: ${suggestion}`);
      lines.push(`PRÓXIMA CHECAGEM: ${nextDelaySec}s`);
      lines.push("");
      if (isGerente && idleAgents.length && suggestion === "AGIR") {
        lines.push("AÇÃO SUGERIDA: use delegar_tarefa para atribuir trabalho aos agentes ociosos listados acima.");
      }
      lines.push("Após agir (ou decidir ficar ocioso), chame marcar_lido para não re-agir nas mesmas mensagens.");

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
        cargo: { type: "string", enum: [...ROLES], description: "Cargo do agente a restaurar." },
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
          `SELECT * FROM chat_messages
           WHERE created_at > ?
             AND agent_id IS NOT ?
             AND (
               to_target = ? OR to_target = ?
               OR (role = 'gerente' AND (type = 'alerta' OR to_target IS NULL))
               OR role = 'dono'
               OR (? = 'gerente' AND to_target IS NULL AND role NOT IN ('gerente','dono'))
             )
           ORDER BY created_at ASC LIMIT 20`
        )
        .all(since, agent.id, agent.name, agent.role, agent.role) as any[];
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
      "Gerente delega uma tarefa a um agente ou cargo. Posta uma decisão prioritária no chat, que aparece no inbox do destinatário no próximo tick. É assim que o gerente orquestra a equipe sem precisar do usuário.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session_id do gerente." },
        para: { type: "string", description: "Nome do agente OU cargo (ex: 'Mateus', 'frontend', 'backend')." },
        tarefa: { type: "string", description: "Descrição clara e acionável do que deve ser feito." },
        contexto: { type: "string", description: "Contexto adicional, dependências, critério de aceite." },
        prioridade: { type: "string", enum: ["normal", "alta", "critica"], default: "normal" },
      },
      required: ["session_id", "para", "tarefa"],
    },
    handler: (args) => {
      const db = getDb();
      const s = requireActiveSession(db, args.session_id);
      if (s.role !== "gerente") throw new Error("Apenas o gerente pode delegar tarefas.");
      const ag = getAgentByActiveSession(db, s.id);
      const ts = now();

      db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(ts, s.id);
      if (ag) touchAgent(db, ag.id);

      const prioridade = args.prioridade ?? "normal";
      const targetAgent = getAgentByIdentifier(db, args.para);
      if (!targetAgent && !ROLES.includes(args.para as any)) {
        throw new Error(
          `'para'='${args.para}' não é cargo válido (${ROLES.join(", ")}) nem agente registrado.`
        );
      }
      if (targetAgent && targetAgent.status === "archived") {
        throw new Error(`Agente ${targetAgent.name} está arquivado — não dá pra delegar pra ele.`);
      }
      const item = createWorkItem(db, {
        title: args.tarefa,
        description: args.contexto ?? null,
        acceptance: "Destinatário entrega via entregar_tarefa com validação executada ou justificativa.",
        priority: prioridade,
        project: s.project ?? null,
        folder: s.folder ?? null,
        assigned_to: targetAgent ? targetAgent.name : args.para,
        assigned_role: targetAgent ? targetAgent.role : ROLES.includes(args.para as any) ? args.para : null,
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
