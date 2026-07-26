import { useEffect, useRef, useState } from "react";
import type { ChatMessageView } from "../types";
import { currentRole, roleBadgeStyle, roleIconStyle, roleTitle } from "../rolePresentation";
import { AgentIcon } from "./AgentIcon";
import { Tooltip } from "./Tooltip";

interface Props {
  messages: ChatMessageView[];
  highlightSessionId: string | null;
  activityCount: number;
  showActivity: boolean;
  onToggleActivity: () => void;
}

const MAX_VISIBLE = 60;

const TYPE_LABEL: Record<string, string> = {
  falar:   "fala",
  pedir:   "pede",
  passar:  "passa",
  alerta:  "alerta",
  decisao: "decisão",
  erro:    "erro",
};

const TYPE_ICON: Record<string, string> = {
  falar:   "◉",
  pedir:   "▶",
  passar:  "→",
  alerta:  "▲",
  decisao: "✓",
  erro:    "✕",
};

function renderMd(raw: string): string {
  const esc = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return esc
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // Heading-level bold (## Título) → bigger heading
    .replace(/^#{1,2} (.+)$/gm, '<span class="md-heading">$1</span>')
    .replace(/^#{3} (.+)$/gm, '<span class="md-subheading">$1</span>')
    // Bold with slight emphasis highlight
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>')
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    // Em dash (— Claude's signature): teal separator + note style after it
    .replace(/ — /g, '<span class="md-emdash"> — </span>')
    .replace(/\n/g, "<br>");
}

export function Chat({ messages, highlightSessionId, activityCount, showActivity, onToggleActivity }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);
  const [clearedBefore, setClearedBefore] = useState(0);

  // Jump to bottom immediately on mount (no smooth — avoids "born at top" bug)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, []);

  // Smooth-scroll only when a genuinely new message arrives
  useEffect(() => {
    const visible = messages.filter((m) => m.created_at > clearedBefore);
    const last = visible[visible.length - 1];
    if (last && last.id !== lastIdRef.current) {
      lastIdRef.current = last.id;
      // Only auto-scroll if user is already near the bottom (within 120px)
      const el = ref.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages, clearedBefore]);

  const filtered = messages.filter((m) => m.created_at > clearedBefore);
  const hidden = Math.max(0, filtered.length - MAX_VISIBLE);
  const visible = filtered.slice(-MAX_VISIBLE);

  return (
    <main className="chat">
      <div className="panel-title">
        Chat ao vivo
        <span className="panel-title-count">{filtered.length}</span>
        <div className="chat-header-actions">
          <Tooltip label={showActivity ? "Esconder painel de atividades" : "Ver o que cada um está fazendo"} side="left">
            <button
              className={`chat-activity-btn${showActivity ? " active" : ""}`}
              onClick={onToggleActivity}
              aria-pressed={showActivity}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>Atividade</span>
              {activityCount > 0 && <span className="chat-activity-count">{activityCount}</span>}
            </button>
          </Tooltip>
          {filtered.length > 0 && (
            <Tooltip label="Limpar visualização (não apaga do banco)" side="left" className="chat-clear-wrap">
              <button
                className="chat-clear-btn"
                onClick={() => { setClearedBefore(Date.now()); lastIdRef.current = null; }}
              >
                limpar
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="chat-scroll" ref={ref}>
        {filtered.length === 0 && (
          <div className="empty">Nenhuma mensagem ainda.</div>
        )}
        {hidden > 0 && (
          <div className="chat-hidden-label">{hidden} mensagem{hidden !== 1 ? "s" : ""} anteriores</div>
        )}
        {visible.map((m) => (
          <div
            key={m.id}
            className={`msg msg-${m.type}${highlightSessionId && m.session_id === highlightSessionId ? " is-highlight" : ""}`}
          >
            <div className="msg-head">
              <span className="agent-icon" style={roleIconStyle(m.role)}><AgentIcon size={13} /></span>
              <span className="msg-author">{m.session_name}</span>
              <Tooltip label={roleTitle(m.role)} side="top">
                <span className="msg-role" style={roleBadgeStyle(m.role)}>{currentRole(m.role)}</span>
              </Tooltip>
              <span className={`msg-type type-${m.type}`}>
                <span className="msg-type-icon">{TYPE_ICON[m.type] ?? ""}</span>
                {TYPE_LABEL[m.type] ?? m.type}
              </span>
              {m.to_target && <span className="msg-target">→ {m.to_target}</span>}
              <Tooltip label={fullDate(m.created_at)} side="left">
                <span className="msg-time">{formatTime(m.created_at)}</span>
              </Tooltip>
            </div>
            <div
              className="msg-body"
              dangerouslySetInnerHTML={{ __html: renderMd(m.message) }}
            />
            {m.files.length > 0 && (
              <div className="msg-files">
                {m.files.map((f) => (
                  <span key={f} className="file-chip">{shortPath(f)}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

function fullDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000)     return `há ${Math.max(1, Math.floor(diff / 1_000))}s`;
  if (diff < 3_600_000)  return `há ${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000);
    return h < 3 ? `há ${h}h` : new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function shortPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}
