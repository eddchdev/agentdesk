import type { ActivityView } from "../types";
import { AgentIcon } from "./AgentIcon";

interface Props {
  activities: ActivityView[];
}

const ROLE_LABELS: Record<string, string> = {
  gerente:  "Gerente",
  frontend: "Frontend",
  backend:  "Backend",
  qa:       "QA",
  bugs:     "Bugs",
  whatsapp: "WhatsApp",
  dono:     "Dono",
};

const ROLE_COLORS: Record<string, string> = {
  gerente:  "var(--role-gerente)",
  frontend: "var(--role-frontend)",
  backend:  "var(--role-backend)",
  qa:       "var(--role-qa)",
  bugs:     "var(--role-bugs)",
  whatsapp: "var(--role-whatsapp)",
  dono:     "var(--role-dono)",
};

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
                <span className="activity-icon" style={{ color: ROLE_COLORS[a.role] ?? "var(--text-muted)" }}>
                  <AgentIcon size={14} />
                </span>
                <span className="activity-name">{a.agent_name}</span>
                <span className="activity-role">{ROLE_LABELS[a.role] ?? a.role}</span>
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
