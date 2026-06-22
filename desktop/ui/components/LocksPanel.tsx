import type { DelegationView, HandoffView, LockView, WorkItemView } from "../types";
import { Tooltip } from "./Tooltip";

interface Props {
  locks: LockView[];
  handoffs: HandoffView[];
  delegations: DelegationView[];
  workItems: WorkItemView[];
  highlightSessionId: string | null;
}

export function LocksPanel({ locks, handoffs, delegations, workItems, highlightSessionId }: Props) {
  const totalDelegated = handoffs.length + delegations.length;
  return (
    <aside className="locks">
      <div className="panel-section">
        <div className="panel-title">
          Work items
          <span className="panel-title-count">{workItems.length}</span>
        </div>
        <ul className="handoff-list">
          {workItems.length === 0 && <li className="empty">Nenhuma tarefa estruturada aberta.</li>}
          {workItems.map((w) => (
            <li key={w.id} className="handoff-row">
              <div className="handoff-line">
                <span className={`tag ${workItemTag(w.status)}`}>{w.status}</span>
                <span className="handoff-target">{w.owner_agent_name ?? w.assigned_to ?? w.assigned_role ?? "sem dono"}</span>
              </div>
              <div className="handoff-task">{w.title}</div>
              {w.blocked_reason && <div className="handoff-note">{w.blocked_reason}</div>}
              {w.worktree_path && (
                <Tooltip label={w.worktree_path} side="left">
                  <div className="handoff-time">{shortPath(w.worktree_path)}</div>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel-section">
        <div className="panel-title">
          Editando agora
          <span className="panel-title-count">{locks.length}</span>
        </div>
        <ul className="lock-list">
          {locks.length === 0 && <li className="empty">Nenhum arquivo em edição.</li>}
          {locks.map((l) => (
            <li
              key={l.id}
              className={`lock-row${highlightSessionId && l.session_id === highlightSessionId ? " is-highlight" : ""}`}
            >
              <Tooltip label={l.file_path} side="left">
                <div className="lock-file">{shortPath(l.file_path)}</div>
              </Tooltip>
              <div className="lock-meta">
                <span className="lock-author">{l.session_name}</span>
                <span className="dim">{l.role}</span>
                {l.area && (
                  <Tooltip label={`Área: ${l.area}`} side="top">
                    <span className="lock-area">{l.area}</span>
                  </Tooltip>
                )}
              </div>
              {l.task_title && (
                <Tooltip label={l.task_title} side="left">
                  <div className="lock-task">↳ {l.task_title}</div>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel-section">
        <div className="panel-title">
          Tarefas delegadas
          <span className="panel-title-count">{totalDelegated}</span>
        </div>
        <ul className="handoff-list">
          {totalDelegated === 0 && <li className="empty">Nenhuma delegação recente.</li>}
          {delegations.map((d) => (
            <li key={d.id} className="handoff-row">
              <div className="handoff-line">
                <span className="dim">{d.from_name}</span>
                <span className="dim"> delegou para </span>
                <span className="handoff-target">{d.to_target}</span>
                <Tooltip
                  label={d.seen ? "Destinatário já viu" : "Aguardando o agente processar"}
                  side="left"
                >
                  <span className={`tag ${d.seen ? "tag-ok" : "tag-pending"}`}>
                    {d.seen ? "vista" : "pendente"}
                  </span>
                </Tooltip>
              </div>
              <div className="handoff-task">{firstLine(d.message)}</div>
              <Tooltip label={fullDate(d.created_at)} side="left">
                <div className="handoff-time">{formatTime(d.created_at)}</div>
              </Tooltip>
            </li>
          ))}
          {handoffs.map((h) => (
            <li key={h.id} className="handoff-row">
              <div className="handoff-line">
                <span className="dim">{h.from_name ?? h.from_session}</span>
                <span className="dim"> passou para </span>
                <span className="handoff-target">{h.to_target}</span>
                <Tooltip
                  label={h.accepted ? `Recebida em ${fullDate(h.accepted_at!)}` : "Aguardando o agente pegar a tarefa"}
                  side="left"
                >
                  <span className={`tag ${h.accepted ? "tag-ok" : "tag-pending"}`}>
                    {h.accepted ? "recebida" : "aguardando"}
                  </span>
                </Tooltip>
              </div>
              {h.task_title && <div className="handoff-task">{h.task_title}</div>}
              {h.note && <div className="handoff-note">{h.note}</div>}
              <Tooltip label={fullDate(h.created_at)} side="left">
                <div className="handoff-time">{formatTime(h.created_at)}</div>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function workItemTag(status: string): string {
  if (status === "blocked") return "tag-pending";
  if (status === "review" || status === "done") return "tag-ok";
  return "";
}

function firstLine(s: string): string {
  // Pega a primeira linha não-cabeçalho (URGENTE — delegação ...)
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith("⚠️") || l.startsWith("🚨") || l.startsWith("📋")) continue;
    return l.length > 120 ? l.slice(0, 117) + "…" : l;
  }
  return lines[0] ?? "";
}

function shortPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function fullDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `há ${Math.max(1, Math.floor(diff / 1_000))}s`;
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)}min`;
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
