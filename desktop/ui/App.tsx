import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot, SessionView } from "./types";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { LocksPanel } from "./components/LocksPanel";
import { AgentIcon } from "./components/AgentIcon";
import { Composer } from "./components/Composer";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { ActivityPanel } from "./components/ActivityPanel";

const FALLBACK_POLL_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 120;

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const nextUnnamedTab = useRef(1);

  interface AgentTab { id: string; name: string; }
  const [tabs, setTabs] = useState<AgentTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("monitor");
  const [termCwd, setTermCwd] = useState<string>("");
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    window.terminal.homedir().then(setTermCwd);
  }, []);

  useEffect(() => window.terminal.onIdentity((id, name) => {
    setTabs((prev) => prev.map((tab) => tab.id === id ? { ...tab, name } : tab));
  }), []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const s = await window.agentdesk.snapshot(termCwd || undefined);
      setSnapshot(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshInFlight.current = false;
    }
  }, [termCwd]);

  useEffect(() => {
    let changeTimer: number | null = null;
    const refreshSoon = () => {
      if (document.hidden || changeTimer !== null) return;
      changeTimer = window.setTimeout(() => {
        changeTimer = null;
        void refresh();
      }, CHANGE_DEBOUNCE_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    const unsubscribe = window.agentdesk.onChanged(refreshSoon);
    const fallbackTimer = window.setInterval(onVisibility, FALLBACK_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(fallbackTimer);
      if (changeTimer !== null) window.clearTimeout(changeTimer);
    };
  }, [refresh]);

  const selected: SessionView | null = useMemo(() => {
    if (!snapshot || !selectedSession) return null;
    return snapshot.sessions.find((s) => s.id === selectedSession) ?? null;
  }, [snapshot, selectedSession]);

  // Lista de destinatários disponíveis a partir do snapshot.
  const recipients = useMemo(() => {
    if (!snapshot) return [];
    const seen = new Set<string>();
    const agents: { label: string; value: string }[] = [];
    for (const s of snapshot.sessions) {
      if (s.status !== "active") continue;
      const name = s.agent_name ?? s.name;
      if (!seen.has(name)) {
        seen.add(name);
        const role = s.role ? ` · papel atual: ${s.role}` : "";
        agents.push({ label: `${name}${role}`, value: name });
      }
    }
    return [{ label: "Todos", value: "__all__" }, ...agents];
  }, [snapshot]);

  const addTab = useCallback(async (name?: string) => {
    const id = `term-${Date.now()}`;
    const requestedName = name?.trim() || undefined;
    const label = requestedName || `Agente ${nextUnnamedTab.current++}`;
    await window.terminal.create(id, requestedName, termCwd || undefined);
    setTabs((prev) => [...prev, { id, name: label }]);
    setActiveTab(id);
  }, [termCwd]);

  const pickDir = useCallback(async () => {
    const dir = await window.terminal.pickDir();
    if (dir) setTermCwd(dir);
  }, []);

  const closeTab = useCallback((id: string) => {
    window.terminal.kill(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeTab === id) {
      // prefer adjacent tab (right > left), fallback to monitor
      const fallback = next[idx] ?? next[idx - 1] ?? null;
      setActiveTab(fallback ? fallback.id : "monitor");
    }
  }, [tabs, activeTab]);

  // Safety net: if activeTab points to a non-existent tab, go to monitor
  useEffect(() => {
    if (activeTab !== "monitor" && !tabs.find((t) => t.id === activeTab)) {
      setActiveTab("monitor");
    }
  }, [tabs, activeTab]);

  return (
    <div className="app-root">
    <TabBar
      tabs={tabs}
      active={activeTab}
      onSelect={setActiveTab}
      onClose={closeTab}
      onAdd={addTab}
      cwd={termCwd}
      onPickDir={pickDir}
    />
    <div className="app" style={{ display: activeTab === "monitor" ? "flex" : "none" }}>
      <Header
        counts={snapshot?.counts}
        error={error}
      />
      {!snapshot && !error && (
        <div className="splash">
          <AgentIcon size={48} className="splash-icon" />
          <span>Carregando AgentDesk…</span>
        </div>
      )}
      {!snapshot && error && (
        <div className="splash error-splash">
          <AgentIcon size={40} className="splash-icon-error" />
          <span className="error-splash-title">Não foi possível conectar</span>
          <span className="error-splash-msg">{error}</span>
        </div>
      )}
      {snapshot && (
        <div className="layout">
          <Sidebar
            sessions={snapshot.sessions}
            selected={selectedSession}
            onSelect={setSelectedSession}
          />
          <Chat
            messages={snapshot.chat}
            highlightSessionId={selectedSession}
            activityCount={snapshot.activities?.length ?? 0}
            showActivity={showActivity}
            onToggleActivity={() => setShowActivity((v) => !v)}
          />
          {showActivity && <ActivityPanel activities={snapshot.activities ?? []} />}
          <LocksPanel
            locks={snapshot.locks}
            handoffs={snapshot.handoffs}
            delegations={snapshot.delegations}
            workItems={snapshot.workItems}
            highlightSessionId={selectedSession}
          />
        </div>
      )}
      {recipients.length > 0 && (
        <Composer recipients={recipients} teamFolder={termCwd || undefined} onSent={refresh} />
      )}
      <div className="footer">
        {selected ? (
          <>
            <strong>{selected.agent_name ?? selected.name}</strong>
            <span className="dim">·</span>
            <span className="dim">papel atual: {selected.role || "não definido"}</span>
            <span className="dim">·</span>
            <span className="footer-task">{selected.task ?? "(sem tarefa)"}</span>
            {selected.folder && <span className="dim" style={{ flexShrink: 0 }} title={selected.folder}>{selected.folder.split("/").slice(-2).join("/")}</span>}
          </>
        ) : (
          <span className="footer-hint">Clique em um agente para ver detalhes</span>
        )}
      </div>
    </div>
    {tabs.map((tab) => (
      <TerminalPane key={tab.id} id={tab.id} name={tab.name} active={activeTab === tab.id} />
    ))}
    </div>
  );
}
