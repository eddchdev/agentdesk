import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { watch } from "node:fs";
import { DB_PATH, deriveTeamKey, openDb, snapshot, sendUserMessage } from "./db.js";
import pty from "node-pty";

// O fs.watch é o caminho rápido. O polling é apenas uma rede de segurança
// para filesystems que eventualmente percam um evento, evitando 4 consultas
// SQLite por segundo enquanto preserva baixa latência no caminho normal.
const POKE_DEBOUNCE_MS = 1_500;
const POKE_POLL_MS = 2_000;
const POKE_MSG = "/auto-tick";

app.setName("AgentDesk");
app.setAppUserModelId("agentdesk");

if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform,WaylandWindowDecorations");
  if (!process.env.ELECTRON_OZONE_PLATFORM_HINT) {
    process.env.ELECTRON_OZONE_PLATFORM_HINT = "auto";
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, "..");
const DEV_URL = process.env.AGENTDESK_DEV ? "http://localhost:5173" : null;
const UI_INDEX = join(PROJECT_ROOT, "dist-ui", "index.html");
const APP_ICON = join(PROJECT_ROOT, "ui", "public", "icon.png");

let mainWindow: BrowserWindow | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const terminals = new Map<string, any>();
interface TerminalMeta {
  requestedName: string | null;
  agentName: string | null;
  agentId: string | null;
  role: string | null;
  teamKey: string;
}
const terminalMeta = new Map<string, TerminalMeta>();
const lastPokeByPty = new Map<string, number>();

function defaultFolder(): string {
  return process.env.AGENTDESK_FOLDER || process.env.HOME || homedir();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "AgentDesk Desktop",
    backgroundColor: "#0f0e0b",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
    },
  });

  mainWindow.webContents.session.setSpellCheckerEnabled(false);

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(UI_INDEX);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  openDb();

  ipcMain.handle("agentdesk:snapshot", (_e, folder?: string) => snapshot(deriveTeamKey(folder || defaultFolder())));
  ipcMain.handle("agentdesk:sendMessage", (_e, to: string | null, message: string, type: string, folder?: string) => {
    sendUserMessage(to, message, (type as any) ?? "alerta", deriveTeamKey(folder || defaultFolder()));
    mainWindow?.webContents.send("agentdesk:changed");
  });

  ipcMain.handle('terminal:homedir', () => defaultFolder());

  ipcMain.handle('terminal:pickDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      defaultPath: process.env.HOME,
      title: 'Selecionar pasta de trabalho dos agentes',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('terminal:create', (_e, id: string, name?: string, cwd?: string) => {
    // Spawn zsh that immediately runs claude. When claude exits, drop to interactive zsh.
    // This guarantees claude launches without any timing/detection issues.
    const startupCmd = `claude --dangerously-skip-permissions; exec zsh -i`;
    const requestedName = name?.trim() || null;
    const folder = cwd || defaultFolder();
    const termEnv: Record<string, string | undefined> = {
      ...process.env,
      AGENTDESK_FOLDER: folder,
      HOME: process.env.HOME || homedir(),
      TERM: 'xterm-256color',
      STARSHIP_LOG: 'error',
      STARSHIP_SCAN_TIMEOUT: '50',
    };
    if (requestedName) termEnv.AGENTDESK_AGENT = requestedName;
    else delete termEnv.AGENTDESK_AGENT;

    const term = pty.spawn('/bin/zsh', ['-l', '-i', '-c', startupCmd], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: folder,
      env: termEnv,
    });

    terminals.set(id, term);
    terminalMeta.set(id, {
      requestedName,
      agentName: requestedName,
      agentId: null,
      role: null,
      teamKey: deriveTeamKey(folder),
    });

    let abrirSent = false;
    let buf = '';
    let abrirFallback: ReturnType<typeof setTimeout> | null = null;

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][AB012]/g, '');

    const sendAbrir = () => {
      if (abrirSent) return;
      abrirSent = true;
      buf = '';
      if (abrirFallback) { clearTimeout(abrirFallback); abrirFallback = null; }
      const argument = requestedName ? ` ${requestedName}` : "";
      setTimeout(() => terminals.get(id)?.write(`/abrir${argument}\r`), 1500);
    };

    // Fallback: envia /abrir após 14s caso a detecção de Welcome falhe
    abrirFallback = setTimeout(sendAbrir, 14_000);

    term.onData((data: string) => {
      mainWindow?.webContents.send('terminal:data', id, data);

      buf += data;
      if (buf.length > 8000) buf = buf.slice(-3000);

      const clean = stripAnsi(buf);

      // Tool output gives us the generated identity even when the tab name was
      // left blank. Binding it here keeps targeted real-time pokes precise.
      const identity = clean.match(/(?:ABERTO|RETOMADO)\s*[·-]\s*([^/\r\n]+)\/([^\r\n]+)/i);
      const agentId = clean.match(/agent_id:\s*([^\s\r\n]+)/i);
      const meta = terminalMeta.get(id);
      if (meta) {
        if (identity) {
          const resolvedName = identity[1].trim();
          if (!meta.requestedName && meta.agentName !== resolvedName) {
            mainWindow?.webContents.send('terminal:identity', id, resolvedName);
          }
          meta.agentName = resolvedName;
          meta.role = identity[2].trim();
        }
        if (agentId) meta.agentId = agentId[1].trim();
      }

      if (abrirSent) return;

      // Claude Code v2.x mostra "Claude Code vX.Y.Z" + "bypass permissions"
      // Older versions mostravam "Welcome back". Suportar ambos.
      const claudeReady =
        clean.includes('Claude Code') ||
        clean.includes('bypass permissions') ||
        clean.includes('Welcome');
      if (claudeReady) sendAbrir();
    });

    term.onExit(() => {
      mainWindow?.webContents.send('terminal:exit', id);
      terminals.delete(id);
      terminalMeta.delete(id);
      lastPokeByPty.delete(id);
      if (abrirFallback) { clearTimeout(abrirFallback); abrirFallback = null; }
    });

    return { ok: true };
  });

  ipcMain.on('terminal:write', (_e, id: string, data: string) => {
    terminals.get(id)?.write(data);
  });

  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) terminals.get(id)?.resize(cols, rows);
  });

  ipcMain.on('terminal:kill', (_e, id: string) => {
    terminals.get(id)?.kill();
    terminals.delete(id);
    terminalMeta.delete(id);
    lastPokeByPty.delete(id);
  });

  // Poke watcher: monitora chat_messages e cutuca PTYs em modo auto
  // (substitui o agentdesk-watcher.mjs externo para agentes spawned no Electron)
  startPokeWatcher();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const term of terminals.values()) try { term.kill(); } catch {}
  terminals.clear();
  if (process.platform !== "darwin") app.quit();
});

function startPokeWatcher() {
  const db = openDb();
  let chatCursor: number = (db.prepare("SELECT MAX(created_at) AS m FROM chat_messages").get() as any)?.m ?? Date.now();
  let workCursor: number = (db.prepare("SELECT MAX(updated_at) AS m FROM work_items").get() as any)?.m ?? Date.now();
  let handoffCursor: number = (db.prepare("SELECT MAX(created_at) AS m FROM handoffs").get() as any)?.m ?? Date.now();

  const findTargetPtys = (agentName: string, teamKey: string): Set<string> => {
    const ptys = new Set<string>();
    for (const [id, meta] of terminalMeta) {
      if (meta.teamKey !== teamKey) continue;
      if (meta.agentName === agentName || meta.requestedName === agentName) {
        ptys.add(id);
      }
    }
    return ptys;
  };

  // Heartbeat passivo: enquanto a aba está aberta, o agente está vivo.
  const keepAlive = () => {
    if (terminalMeta.size === 0) return;
    try {
      const byId = db.prepare(
        `SELECT id, current_session_id FROM agents
         WHERE id = ? AND team_key = ? AND status NOT IN ('archived','dead')`
      );
      const byName = db.prepare(
        `SELECT id, current_session_id FROM agents
         WHERE name = ? AND team_key = ? AND status NOT IN ('archived','dead')`
      );
      const ts = Date.now();
      const touched = new Set<string>();
      for (const meta of terminalMeta.values()) {
        const a = (meta.agentId
          ? byId.get(meta.agentId, meta.teamKey)
          : meta.agentName
            ? byName.get(meta.agentName, meta.teamKey)
            : undefined) as { id: string; current_session_id: string | null } | undefined;
        if (!a || touched.has(a.id)) continue;
        touched.add(a.id);
        db.prepare("UPDATE agents SET last_heartbeat = ?, updated_at = ? WHERE id = ?").run(ts, ts, a.id);
        if (a.current_session_id) {
          db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ? AND status != 'closed'").run(ts, a.current_session_id);
        }
      }
    } catch (e) {
      console.error("[keep-alive]", e instanceof Error ? e.message : e);
    }
  };
  setInterval(keepAlive, 30_000);
  setTimeout(keepAlive, 2_000);

  // pokePty: dispara /auto-tick em um pty, respeitando debounce (urgente bypass).
  const pokePty = (ptyId: string, urgent: boolean, reason: string) => {
    const term = terminals.get(ptyId);
    if (!term) return false;
    if (!urgent) {
      const last = lastPokeByPty.get(ptyId) ?? 0;
      if (Date.now() - last < POKE_DEBOUNCE_MS) return false;
    }
    try {
      term.write(`${POKE_MSG}\r`);
      lastPokeByPty.set(ptyId, Date.now());
      console.log(`[poke] ${ptyId} motivo=${reason}${urgent ? " URGENTE" : ""}`);
      return true;
    } catch {
      return false;
    }
  };

  // Resolve nome ou papel livre, sempre dentro da equipe de origem.
  const resolveTargets = (to: string | null, fromAgentId: string | null, teamKey: string): Set<string> => {
    const ptys = new Set<string>();
    if (!to) return ptys;
    const matches = db.prepare(
      `SELECT id, name, role FROM agents
       WHERE team_key = ? AND (name = ? OR role = ?)
         AND auto_mode = 1 AND status NOT IN ('archived','dead')`
    ).all(teamKey, to, to) as Array<{ id: string; name: string; role: string }>;
    for (const a of matches) {
      if (fromAgentId && a.id === fromAgentId) continue;
      // The query already expands a free-form role to every matching agent;
      // binding each result by name avoids waking unrelated peers on name sends.
      for (const pty of findTargetPtys(a.name, teamKey)) ptys.add(pty);
    }
    for (const [id, meta] of terminalMeta) {
      if (meta.teamKey !== teamKey || (fromAgentId && meta.agentId === fromAgentId)) continue;
      if (meta.requestedName === to || meta.agentName === to || meta.role === to) ptys.add(id);
    }
    return ptys;
  };

  const managerTargets = (teamKey: string, fromAgentId: string | null): Set<string> => {
    const ptys = new Set<string>();
    const managers = db.prepare(
      `SELECT id, name, role FROM agents
       WHERE team_key = ? AND authority = 'manager'
         AND auto_mode = 1 AND status NOT IN ('archived','dead')`
    ).all(teamKey) as Array<{ id: string; name: string; role: string }>;
    for (const manager of managers) {
      if (fromAgentId && manager.id === fromAgentId) continue;
      for (const pty of findTargetPtys(manager.name, teamKey)) ptys.add(pty);
    }
    return ptys;
  };

  const peerReviewerTargets = (workItem: { id: string; team_key: string; owner_agent_id: string | null }): Set<string> => {
    const candidates = db.prepare(
      `SELECT a.id, a.name
       FROM agents a
       WHERE a.team_key = ? AND a.authority = 'worker'
         AND a.id <> COALESCE(?, '')
         AND a.auto_mode = 1 AND a.status NOT IN ('archived','dead')
       ORDER BY EXISTS(
         SELECT 1 FROM work_items own WHERE own.owner_agent_id = a.id AND own.status = 'working'
       ) ASC,
         CASE WHEN a.id >= ? THEN 0 ELSE 1 END ASC,
         a.id ASC`
    ).all(workItem.team_key, workItem.owner_agent_id, workItem.id) as Array<{ id: string; name: string }>;
    for (const candidate of candidates) {
      const ptys = findTargetPtys(candidate.name, workItem.team_key);
      if (ptys.size) return new Set([ptys.values().next().value as string]);
    }
    return managerTargets(workItem.team_key, workItem.owner_agent_id);
  };

  const broadcastTargets = (teamKey: string, fromAgentId: string | null): Set<string> => {
    const ptys = new Set<string>();
    for (const [id, meta] of terminalMeta) {
      if (meta.teamKey === teamKey && (!fromAgentId || meta.agentId !== fromAgentId)) ptys.add(id);
    }
    return ptys;
  };

  // Drena chat + work_items + handoffs num único tick.
  const drain = () => {
    if (terminalMeta.size === 0) return;
    try {
      // ─── Chat messages ───────────────────────────────────────────
      const newMsgs = db.prepare(
        `SELECT cm.id, cm.created_at, cm.session_id, cm.agent_id, cm.agent_name,
                cm.role, cm.type, cm.to_target, cm.team_key, a.authority
           FROM chat_messages cm
           LEFT JOIN agents a ON a.id = cm.agent_id
          WHERE cm.created_at > ? ORDER BY cm.created_at ASC LIMIT 200`
      ).all(chatCursor) as Array<{
        id: string; created_at: number; session_id: string; agent_id: string | null;
        agent_name: string | null; role: string; type: string; to_target: string | null;
        team_key: string; authority: string | null;
      }>;

      for (const m of newMsgs) {
        if (m.created_at > chatCursor) chatCursor = m.created_at;
        const fromOwner = m.session_id === "desktop-owner";
        if (!fromOwner && !["pedir","passar","alerta","decisao","falar"].includes(m.type)) continue;

        const fromManager = m.authority === "manager";
        const urgent = fromOwner || m.type === "alerta" || m.type === "passar"
          || (fromManager && (m.type === "pedir" || m.type === "decisao" || m.type === "falar"));

        let ptys: Set<string>;
        if (m.to_target) {
          ptys = resolveTargets(m.to_target, m.agent_id, m.team_key);
        } else if (fromOwner || (fromManager && (m.type === "alerta" || m.type === "falar" || m.type === "decisao"))) {
          // Broadcast do usuário/coordenação: acorda todo o time.
          ptys = broadcastTargets(m.team_key, m.agent_id);
        } else if (!fromManager && (m.type === "falar" || m.type === "alerta" || m.type === "decisao")) {
          // Respostas de trabalhadores sobem à autoridade da equipe, sem
          // depender do texto que estiver em "papel atual".
          ptys = managerTargets(m.team_key, m.agent_id);
        } else {
          continue;
        }
        for (const pty of ptys) pokePty(pty, urgent, `chat.${m.type}`);
      }

      // ─── Work items (delegação, blocked, review) ────────────────
      const newItems = db.prepare(
        `SELECT id, status, priority, assigned_to, assigned_role, owner_agent_id, owner_agent_name, updated_at, team_key
         FROM work_items WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 50`
      ).all(workCursor) as Array<{
        id: string; status: string; priority: string;
        assigned_to: string | null; assigned_role: string | null;
        owner_agent_id: string | null; owner_agent_name: string | null;
        updated_at: number; team_key: string;
      }>;

      for (const w of newItems) {
        if (w.updated_at > workCursor) workCursor = w.updated_at;
        if (!["queued", "blocked", "review"].includes(w.status)) continue;
        const urgent = w.priority === "critica" || w.priority === "alta" || w.status === "review";
        let ptys: Set<string>;
        if (w.status === "review") {
          ptys = peerReviewerTargets(w);
        } else {
          const target = w.assigned_to || w.assigned_role || w.owner_agent_name;
          ptys = resolveTargets(target, null, w.team_key);
        }
        for (const pty of ptys) pokePty(pty, urgent, `work_item.${w.status}`);
      }

      // ─── Handoffs ────────────────────────────────────────────────
      const newHandoffs = db.prepare(
        `SELECT id, to_target, from_session, created_at, team_key
         FROM handoffs WHERE created_at > ? AND accepted = 0 ORDER BY created_at ASC LIMIT 20`
      ).all(handoffCursor) as Array<{
        id: string; to_target: string; from_session: string; created_at: number; team_key: string;
      }>;

      for (const h of newHandoffs) {
        if (h.created_at > handoffCursor) handoffCursor = h.created_at;
        const ptys = resolveTargets(h.to_target, null, h.team_key);
        for (const pty of ptys) pokePty(pty, true, `handoff`);
      }
    } catch (e) {
      console.error("[poke-watcher]", e instanceof Error ? e.message : e);
    }
  };

  setInterval(drain, POKE_POLL_MS);

  // fs.watch como gatilho sub-50ms (cada commit do MCP server escreve no -wal).
  let pendingDrain: NodeJS.Timeout | null = null;
  try {
    const dbDir = dirname(DB_PATH);
    const dbBase = basename(DB_PATH);
    watch(dbDir, { persistent: false }, (_evt, fn) => {
      if (!fn) return;
      if (fn === `${dbBase}-wal` || fn === `${dbBase}-shm`) {
        if (pendingDrain) return;
        pendingDrain = setTimeout(() => {
          pendingDrain = null;
          drain();
          mainWindow?.webContents.send("agentdesk:changed");
        }, 30);
      }
    });
    console.log(`[poke-watcher] fs.watch ativo em ${dbDir}`);
  } catch (e) {
    console.log(`[poke-watcher] fs.watch indisponível: ${e instanceof Error ? e.message : e}`);
  }
}
