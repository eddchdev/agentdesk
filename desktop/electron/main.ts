import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { watch } from "node:fs";
import { openDb, snapshot, sendUserMessage } from "./db.js";
import pty from "node-pty";

// Real-time tuning. Antes: poll 1000ms + debounce 5000ms = latência típica
// 1-5s entre agentes. Agora: poll 250ms + fs.watch (~50ms) + debounce 1500ms
// = latência tipica <300ms, urgentes <100ms.
const POKE_DEBOUNCE_MS = 1_500;
const POKE_POLL_MS = 250;
const POKE_MSG = "/auto-tick";
const DB_PATH = process.env.AGENTDESK_DB ?? join(homedir(), ".agentdesk", "agentdesk.db");

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
const terminals = new Map<string, any>();
const ptyByName = new Map<string, string>(); // tab name (role) -> PTY id
const lastPokeByPty = new Map<string, number>();

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
    },
  });

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
  openDb();

  ipcMain.handle("agentdesk:snapshot", () => snapshot());
  ipcMain.handle("agentdesk:sendMessage", (_e, to: string | null, message: string, type: string) => {
    sendUserMessage(to, message, (type as any) ?? "alerta");
  });

  ipcMain.handle('terminal:homedir', () => process.env.HOME || '/home/eddch');

  ipcMain.handle('terminal:pickDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      defaultPath: process.env.HOME,
      title: 'Selecionar pasta de trabalho dos agentes',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('terminal:create', (_e, id: string, name: string, cwd?: string) => {
    // Spawn zsh that immediately runs claude. When claude exits, drop to interactive zsh.
    // This guarantees claude launches without any timing/detection issues.
    const startupCmd = `claude --dangerously-skip-permissions; exec zsh -i`;
    const term = pty.spawn('/bin/zsh', ['-l', '-i', '-c', startupCmd], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.env.HOME || '/home/eddch',
      env: {
        ...process.env,
        AGENTDESK_AGENT: name,
        // Propagado pro MCP server: quando /abrir não passa pasta, o tool usa
        // essa env como fallback. Evita criar agente duplicado na mesma pasta
        // só porque a skill esqueceu de incluir o cwd.
        AGENTDESK_FOLDER: cwd || process.env.HOME || '/home/eddch',
        HOME: process.env.HOME || '/home/eddch',
        TERM: 'xterm-256color',
        STARSHIP_LOG: 'error',
        STARSHIP_SCAN_TIMEOUT: '50',
      },
    });

    terminals.set(id, term);
    ptyByName.set(name, id);

    let abrirSent = false;
    let buf = '';
    let abrirFallback: ReturnType<typeof setTimeout> | null = null;

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][AB012]/g, '');

    const sendAbrir = () => {
      if (abrirSent) return;
      abrirSent = true;
      buf = '';
      if (abrirFallback) { clearTimeout(abrirFallback); abrirFallback = null; }
      setTimeout(() => terminals.get(id)?.write(`/abrir ${name}\r`), 1500);
      // Auto-liga modo autônomo 12s depois do /abrir. Garante que cada tab
      // já recebe pokes em tempo real sem precisar do usuário digitar /auto.
      // Atraso de 12s dá tempo do /abrir terminar de criar/retomar agente,
      // logar contexto e voltar pro prompt idle.
      setTimeout(() => {
        const t = terminals.get(id);
        if (t) t.write(`/auto\r`);
      }, 12_000);
    };

    // Fallback: envia /abrir após 14s caso a detecção de Welcome falhe
    abrirFallback = setTimeout(sendAbrir, 14_000);

    term.onData((data: string) => {
      mainWindow?.webContents.send('terminal:data', id, data);

      if (abrirSent) return;

      buf += data;
      if (buf.length > 8000) buf = buf.slice(-3000);

      const clean = stripAnsi(buf);

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
      for (const [k, v] of ptyByName.entries()) if (v === id) ptyByName.delete(k);
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
    for (const [k, v] of ptyByName.entries()) if (v === id) ptyByName.delete(k);
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

  const findTargetPty = (agentName: string | null, agentRole: string | null): string | undefined => {
    if (agentName && ptyByName.has(agentName)) return ptyByName.get(agentName);
    if (agentRole && ptyByName.has(agentRole)) return ptyByName.get(agentRole);
    return undefined;
  };

  // Heartbeat passivo: enquanto a aba está aberta, o agente está vivo.
  const keepAlive = () => {
    if (ptyByName.size === 0) return;
    const tabNames = Array.from(ptyByName.keys());
    const placeholders = tabNames.map(() => "?").join(",");
    try {
      const rows = db.prepare(
        `SELECT id, name, role, current_session_id FROM agents
         WHERE status NOT IN ('archived','dead')
           AND (name IN (${placeholders}) OR role IN (${placeholders}))`
      ).all(...tabNames, ...tabNames) as Array<{ id: string; name: string; role: string; current_session_id: string | null }>;
      const ts = Date.now();
      for (const a of rows) {
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

  // Resolve alvos pra um destinatário (nome de agente OU cargo).
  // Inclui fallback: nome da TAB (caso agente ainda não registrado).
  const resolveTargets = (to: string | null, fromAgentId: string | null): Set<string> => {
    const ptys = new Set<string>();
    if (!to) return ptys;
    const matches = db.prepare(
      `SELECT id, name, role FROM agents
       WHERE (name = ? OR role = ?) AND auto_mode = 1 AND status NOT IN ('archived','dead')`
    ).all(to, to) as Array<{ id: string; name: string; role: string }>;
    for (const a of matches) {
      if (fromAgentId && a.id === fromAgentId) continue;
      const pty = findTargetPty(a.name, a.role);
      if (pty) ptys.add(pty);
    }
    if (ptyByName.has(to)) ptys.add(ptyByName.get(to)!);
    return ptys;
  };

  const broadcastTargets = (fromAgentId: string | null): Set<string> => {
    const ptys = new Set<string>();
    const all = db.prepare(
      `SELECT id, name, role FROM agents
       WHERE auto_mode = 1 AND status NOT IN ('archived','dead')`
    ).all() as Array<{ id: string; name: string; role: string }>;
    for (const a of all) {
      if (fromAgentId && a.id === fromAgentId) continue;
      const pty = findTargetPty(a.name, a.role);
      if (pty) ptys.add(pty);
    }
    return ptys;
  };

  // Drena chat + work_items + handoffs num único tick.
  const drain = () => {
    if (ptyByName.size === 0) return;
    try {
      // ─── Chat messages ───────────────────────────────────────────
      const newMsgs = db.prepare(
        `SELECT id, created_at, agent_id, agent_name, role, type, to_target
         FROM chat_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
      ).all(chatCursor) as Array<{
        id: string; created_at: number; agent_id: string | null;
        agent_name: string | null; role: string; type: string; to_target: string | null;
      }>;

      for (const m of newMsgs) {
        if (m.created_at > chatCursor) chatCursor = m.created_at;
        const isDono = m.role === "dono";
        if (!isDono && !["pedir","passar","alerta","decisao","falar"].includes(m.type)) continue;

        const fromManager = m.role === "gerente";
        const urgent = isDono || m.type === "alerta" || m.type === "passar"
          || (fromManager && (m.type === "pedir" || m.type === "decisao" || m.type === "falar"));

        let ptys: Set<string>;
        if (m.to_target) {
          ptys = resolveTargets(m.to_target, m.agent_id);
        } else if (isDono || (fromManager && (m.type === "alerta" || m.type === "falar" || m.type === "decisao"))) {
          // Broadcast do dono/gerente: acorda todo o time.
          ptys = broadcastTargets(m.agent_id);
        } else if (!fromManager && (m.type === "falar" || m.type === "alerta" || m.type === "decisao")) {
          // Broadcast de SUBORDINADO: acorda apenas gerentes — pra resposta
          // subir até a coordenação sem despertar o time inteiro.
          // Antes: subordinado falando broadcast era ignorado, então quando
          // backend respondia ao gerente, ninguém acordava → conversa morria.
          ptys = resolveTargets("gerente", m.agent_id);
        } else {
          continue;
        }
        for (const pty of ptys) pokePty(pty, urgent, `chat.${m.type}`);
      }

      // ─── Work items (delegação, blocked, review) ────────────────
      const newItems = db.prepare(
        `SELECT id, status, priority, assigned_to, assigned_role, owner_agent_id, owner_agent_name, updated_at
         FROM work_items WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 50`
      ).all(workCursor) as Array<{
        id: string; status: string; priority: string;
        assigned_to: string | null; assigned_role: string | null;
        owner_agent_id: string | null; owner_agent_name: string | null;
        updated_at: number;
      }>;

      for (const w of newItems) {
        if (w.updated_at > workCursor) workCursor = w.updated_at;
        if (!["queued", "blocked", "review"].includes(w.status)) continue;
        const urgent = w.priority === "critica" || w.priority === "alta" || w.status === "review";
        let ptys: Set<string>;
        if (w.status === "review") {
          ptys = new Set([
            ...resolveTargets("qa", null),
            ...resolveTargets("gerente", null),
          ]);
        } else {
          const target = w.assigned_to || w.assigned_role || w.owner_agent_name;
          ptys = resolveTargets(target, null);
        }
        for (const pty of ptys) pokePty(pty, urgent, `work_item.${w.status}`);
      }

      // ─── Handoffs ────────────────────────────────────────────────
      const newHandoffs = db.prepare(
        `SELECT id, to_target, from_session, created_at
         FROM handoffs WHERE created_at > ? AND accepted = 0 ORDER BY created_at ASC LIMIT 20`
      ).all(handoffCursor) as Array<{ id: string; to_target: string; from_session: string; created_at: number }>;

      for (const h of newHandoffs) {
        if (h.created_at > handoffCursor) handoffCursor = h.created_at;
        const ptys = resolveTargets(h.to_target, null);
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
        }, 30);
      }
    });
    console.log(`[poke-watcher] fs.watch ativo em ${dbDir}`);
  } catch (e) {
    console.log(`[poke-watcher] fs.watch indisponível: ${e instanceof Error ? e.message : e}`);
  }
}
