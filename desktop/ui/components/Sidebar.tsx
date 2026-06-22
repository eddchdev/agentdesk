import type { SessionView } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Tooltip } from "./Tooltip";

interface Props {
  sessions: SessionView[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}

const STATUS_ORDER: Record<SessionView["status"], number> = {
  active: 0, suspect: 1, dead: 2, closed: 3,
};

const STATUS_PT: Record<SessionView["status"], string> = {
  active: "ativo", suspect: "atrasado", dead: "inativo", closed: "encerrado",
};

const STATUS_TOOLTIP: Record<SessionView["status"], string> = {
  active:  "Heartbeat recente — agente respondendo",
  suspect: "Sem heartbeat há +1 min — pode estar travado",
  dead:    "Sem heartbeat há +3 min — provavelmente inativo",
  closed:  "Sessão encerrada",
};

const ROLE_PT: Record<string, string> = {
  gerente: "Gerente", backend: "Backend", frontend: "Frontend",
  bugs: "Bugs", whatsapp: "WhatsApp", qa: "QA", dono: "Dono",
};

export function Sidebar({ sessions, selected, onSelect }: Props) {
  const sorted = [...sessions].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    return b.last_heartbeat - a.last_heartbeat;
  });

  return (
    <aside className="sidebar">
      <div className="panel-title">
        Agentes
        <span className="panel-title-count">{sorted.length}</span>
      </div>
      <ul className="session-list">
        {sorted.map((s) => {
          const displayName = s.agent_name ?? s.name;
          return (
            <li
              key={s.id}
              className={`session-row ${selected === s.id ? "is-selected" : ""}`}
              onClick={() => onSelect(selected === s.id ? null : s.id)}
            >
              <div className="session-head">
                <Tooltip label={ROLE_PT[s.role] ?? s.role} side="right">
                  <span className={`agent-icon role-${s.role}`}>
                    <AgentIcon size={15} />
                  </span>
                </Tooltip>
                <span className="session-name">{displayName}</span>
                <span className={`session-role role-${s.role}`}>{ROLE_PT[s.role] ?? s.role}</span>
              </div>
              <div className="session-task">{s.task ?? "(sem tarefa)"}</div>
              <div className="session-meta">
                <Tooltip label={STATUS_TOOLTIP[s.status]} side="right">
                  <span className={`status-text status-${s.status}`}>{STATUS_PT[s.status]}</span>
                </Tooltip>
                {s.agent_name && (
                  <Tooltip label={`ID: ${s.id}`} side="top">
                    <span className="session-id">{s.name}</span>
                  </Tooltip>
                )}
                <Tooltip label={fullDate(s.last_heartbeat)} side="left">
                  <span className="muted">{formatAgo(s.last_heartbeat)}</span>
                </Tooltip>
              </div>
            </li>
          );
        })}
        {sorted.length === 0 && (
          <li className="empty">Nenhum agente ativo.</li>
        )}
      </ul>
    </aside>
  );
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000)     return "agora";
  if (diff < 60_000)    return `há ${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)}h`;
  return `há ${Math.floor(diff / 86_400_000)}d`;
}

function fullDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
