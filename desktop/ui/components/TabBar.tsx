import { useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { Tooltip } from "./Tooltip";

interface Tab { id: string; name: string; }

interface Props {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: (name?: string) => void;
  cwd: string;
  onPickDir: () => void;
}

function shortCwd(cwd: string): string {
  if (!cwd) return "~";
  const home = cwd.match(/^\/home\/[^/]+/) ? cwd.match(/^\/home\/[^/]+/)![0] : null;
  const rel = home ? cwd.replace(home, "~") : cwd;
  const parts = rel.split("/").filter(Boolean);
  if (parts.length <= 2) return rel || "~";
  return "~/" + parts.slice(-2).join("/");
}

export function TabBar({ tabs, active, onSelect, onClose, onAdd, cwd, onPickDir }: Props) {
  const [adding, setAdding] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const openInput = () => {
    setAdding(true);
    // Let the element mount first, then trigger CSS transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setInputOpen(true);
        inputRef.current?.focus();
      });
    });
  };

  const close = () => {
    setInputOpen(false); // triggers CSS close transition
    setTimeout(() => {   // unmount after animation completes (~expo-out done by 260ms)
      setAdding(false);
      setNewName("");
    }, 280);
  };

  const confirm = () => {
    onAdd(newName.trim() || undefined);
    close();
  };

  return (
    <div className="tabbar">
      <div
        className={`tab tab-monitor${active === "monitor" ? " active" : ""}`}
        onClick={() => onSelect("monitor")}
      >
        <span className="tab-icon">
          <img src="./logo.png" width={20} height={20} alt="" style={{ imageRendering: "auto" }} />
        </span>
        <span className="tab-label">Monitor</span>
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${active === tab.id ? " active" : ""}${confirmId === tab.id ? " tab-confirming" : ""}`}
          onClick={() => confirmId === tab.id ? null : onSelect(tab.id)}
        >
          {confirmId === tab.id ? (
            <>
              <span className="tab-confirm-label">Fechar {tab.name}?</span>
              <button
                className="tab-confirm-yes"
                onClick={(e) => { e.stopPropagation(); setConfirmId(null); onClose(tab.id); }}
              >✓</button>
              <button
                className="tab-confirm-no"
                onClick={(e) => { e.stopPropagation(); setConfirmId(null); }}
              >✕</button>
            </>
          ) : (
            <>
              <span className="tab-icon" style={{ color: "var(--text-dim)" }}>
                <AgentIcon size={12} />
              </span>
              <span className="tab-label">{tab.name}</span>
              <Tooltip label="Fechar aba" side="bottom">
                <button
                  className="tab-close"
                  onClick={(e) => { e.stopPropagation(); setConfirmId(tab.id); }}
                  aria-label="Fechar aba"
                >
                  ×
                </button>
              </Tooltip>
            </>
          )}
        </div>
      ))}

      <div className="tab-add-area">
        <Tooltip label="Abrir terminal de agente" side="bottom">
          <button
            className={`tab-add${adding ? " tab-add-faded" : ""}`}
            onClick={openInput}
            tabIndex={adding ? -1 : 0}
          >
            +
          </button>
        </Tooltip>
        {adding && (
          <input
            ref={inputRef}
            className={`tab-new-input${inputOpen ? " tab-new-input-open" : ""}`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="nome opcional do agente"
            aria-label="Nome opcional do agente ou da aba"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            tabIndex={inputOpen ? 0 : -1}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") confirm();
              if (e.key === "Escape") close();
            }}
            onBlur={() => { if (!newName.trim()) close(); }}
          />
        )}
      </div>

      <Tooltip label={cwd || "Pasta de trabalho dos agentes"} side="bottom">
        <button className="tab-cwd" onClick={onPickDir} style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="tab-cwd-path">{shortCwd(cwd)}</span>
        </button>
      </Tooltip>
    </div>
  );
}
