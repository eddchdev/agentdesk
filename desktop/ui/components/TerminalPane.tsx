import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { AgentIcon } from "./AgentIcon";
import "@xterm/xterm/css/xterm.css";

interface Props {
  id: string;
  active: boolean;
  name?: string;
}

export function TerminalPane({ id, active, name }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [loading, setLoading] = useState(true);
  // Buffer incoming data before the terminal is mounted
  const pendingRef = useRef<string[]>([]);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      scrollback: 500,
      theme: {
        // Design system warm-dark palette
        background:          "#0f0e0b",
        foreground:          "#e8e3d5",
        cursor:              "#f54e00",
        cursorAccent:        "#0f0e0b",
        selectionBackground: "rgba(245,78,0,0.18)",
        // ANSI — paleta pastel do design system
        black:         "#262219",
        red:           "#cf4060",
        green:         "#9fc9a2",
        yellow:        "#e3b47e",   // --type-pedir (âmbar)
        blue:          "#9fbbe0",
        magenta:       "#c0a8dd",
        cyan:          "#6ecfcf",   // --type-falar (teal)
        white:         "#e8e3d5",   // --text
        brightBlack:   "#5c5648",   // --text-muted
        brightRed:     "#e07575",   // --type-alerta
        brightGreen:   "#68c4a0",   // --type-decisao (verde-água)
        brightYellow:  "#c08532",   // --active (ouro)
        brightBlue:    "#9fbbe0",
        brightMagenta: "#a98be0",   // --type-passar (violeta)
        brightCyan:    "#89dceb",
        brightWhite:   "#f0eee8",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    // Canvas renderer: one canvas element instead of thousands of DOM nodes
    term.loadAddon(new CanvasAddon());
    fitAddon.fit();

    // Flush buffered data from before terminal mounted
    mountedRef.current = true;
    for (const chunk of pendingRef.current) term.write(chunk);
    pendingRef.current = [];

    termRef.current = term;
    fitRef.current = fitAddon;

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const unsubData = window.terminal.onData((tid, data) => {
      if (tid !== id) return;
      if (mountedRef.current) {
        term.write(data);
      } else {
        pendingRef.current.push(data);
      }
      if (loading) {
        const c = stripAnsi(data);
        if (c.includes('Claude Code') || c.includes('bypass permissions') || c.includes('Welcome')) {
          setTimeout(() => setLoading(false), 400);
        }
      }
    });

    // Fallback: esconde loading após 5s independente
    const fallbackTimer = setTimeout(() => setLoading(false), 5000);

    const unsubExit = window.terminal.onExit((tid) => {
      if (tid === id) term.write("\r\n\x1b[31m[processo encerrado]\x1b[0m\r\n");
    });

    term.onData((data) => window.terminal.write(id, data));

    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });

    return () => {
      clearTimeout(fallbackTimer);
      mountedRef.current = false;
      unsubData();
      unsubExit();
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!active || !fitRef.current) return;
    const fit = () => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      const dims = fitRef.current.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) window.terminal.resize(id, dims.cols, dims.rows);
    };
    fit();
    // Canvas renderer não repaint sozinho após display:none → flex. Força refresh.
    if (termRef.current) {
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }
    const obs = new ResizeObserver(fit);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [active, id]);

  return (
    <div className="terminal-view" style={{ display: active ? "flex" : "none" }}>
      {loading && (
        <div className="terminal-loading">
          <div className="terminal-loading-icon">
            <AgentIcon size={48} />
          </div>
          <span className="terminal-loading-label">{name ?? "agente"}</span>
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-pane"
        style={{ opacity: loading ? 0 : 1, transition: "opacity 0.4s ease" }}
      />
    </div>
  );
}
