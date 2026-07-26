import type { ActivityView } from "../types";
import { currentRole, roleIconStyle, roleTitle } from "../rolePresentation";
import { AgentIcon } from "./AgentIcon";

interface Props {
  activities: ActivityView[];
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `há ${Math.max(1, Math.floor(diff / 1_000))}s`;
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function ActivityPanel({ activities }: Props) {
  return (
    <aside className="activity-panel">
      <div className="panel-title">
        Trabalhando agora
        <span className="panel-title-count">{activities.length}</span>
      </div>
      {activities.length === 0 ? (
        <div className="activity-empty">
          Ninguém está em sessão ativa no momento.
        </div>
      ) : (
        <ul className="activity-list">
          {activities.map((a) => (
            <li
              key={a.session_id}
              className={`activity-row activity-${a.status}`}
            >
              <div className="activity-head">
                <span className="activity-icon" style={roleIconStyle(a.role)}>
                  <AgentIcon size={14} />
                </span>
                <span className="activity-name">{a.agent_name}</span>
                <span className="activity-role" title={roleTitle(a.role)}>{currentRole(a.role)}</span>
              </div>
              <div className="activity-text">{a.description}</div>
              <div className="activity-time">{formatTime(a.updated_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
