import { useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";

interface Recipient { label: string; value: string; }
interface Props { recipients: Recipient[]; teamFolder?: string; onSent: () => void; }

const TYPE_OPTS = [
  { value: "falar",   label: "Fala",    icon: "◉" },
  { value: "pedir",   label: "Pede",    icon: "▶" },
  { value: "alerta",  label: "Alerta",  icon: "▲" },
  { value: "decisao", label: "Decisão", icon: "✓" },
];

export function Composer({ recipients, teamFolder, onSent }: Props) {
  const [to, setTo]           = useState("__all__");
  const [type, setType]       = useState("falar");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await window.agentdesk.sendMessage(to === "__all__" ? null : to, text, type, teamFolder);
      setMessage("");
      onSent();
      inputRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const selectedRecipient = recipients.find(r => r.value === to) ?? recipients[0];
  const selectedType = TYPE_OPTS.find(t => t.value === type) ?? TYPE_OPTS[0];

  return (
    <div className="composer">
      <div className="composer-controls">
        <DropUp
          options={recipients}
          value={to}
          onChange={setTo}
          placeholder="Para…"
          className="composer-to-select"
        />
        <div className="composer-types">
          {TYPE_OPTS.map(t => (
            <button
              key={t.value}
              className={`type-pill type-${t.value} ${type === t.value ? "is-active" : ""}`}
              onClick={() => setType(t.value)}
              title={t.label}
            >
              <span>{t.icon}</span>
              <span className="type-pill-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="composer-input-row">
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder={`Enviar como "${selectedType.label}" para "${selectedRecipient?.label ?? "Todos"}"…`}
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={sending}
        />
        <Tooltip label="Enviar mensagem (Enter)" side="top">
          <button
            className="composer-send"
            onClick={send}
            disabled={!message.trim() || sending}
          >
            {sending ? "…" : "↑"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function DropUp({ options, value, onChange, placeholder, className }: {
  options: Recipient[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className={`dropup ${className ?? ""} ${open ? "is-open" : ""}`} ref={ref}>
      <button className="dropup-btn" onClick={() => setOpen(o => !o)}>
        <span className="dropup-label">{selected?.label ?? placeholder ?? "—"}</span>
        <span className="dropup-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <ul className="dropup-list">
          {options.map(opt => (
            <li
              key={opt.value}
              className={`dropup-opt ${opt.value === value ? "is-selected" : ""}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
