// Cliente WebSocket para o broker AgentDesk.
//
// Cada servidor MCP abre UMA conexão lazy com o broker e envia notify() depois
// de cada escrita relevante (chat, work_item, handoff). O broker dispara o
// tmux send-keys instantaneamente — sem polling, sem fs.watch como fonte
// principal.
//
// Se o broker estiver desligado, a operação não bloqueia. O watcher legacy
// (fs.watch + polling) continua funcionando como fallback.

import { WebSocket } from "ws";

const BROKER_URL = process.env.AGENTDESK_BROKER_URL ?? "ws://127.0.0.1:8787";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

let ws: WebSocket | null = null;
let connecting = false;
let reconnectDelay = RECONNECT_MIN_MS;
let outbox: string[] = [];
let disabled = false;

export type NotifyKind = "chat" | "work_item" | "handoff" | "lock" | "agent";

export interface Notify {
  kind: NotifyKind;
  type?: string;                 // "pedir" | "alerta" | "delegated" | "delivered" | ...
  to?: string | null;            // nome do agente OU cargo OU null (broadcast)
  from_agent_id?: string | null; // pra não acordar o autor
  from_role?: string | null;     // role do remetente (pra urgência: gerente pedir/decisao)
  team_key?: string | null;      // impede acordar agentes de outro projeto
  urgent?: boolean;
  priority?: string;
  message_id?: string;
  work_item_id?: string;
}

function connect() {
  if (disabled || ws || connecting) return;
  connecting = true;
  try {
    ws = new WebSocket(BROKER_URL);
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    connecting = false;
    reconnectDelay = RECONNECT_MIN_MS;
    flush();
  });
  ws.on("error", () => { /* deixa o close cuidar */ });
  ws.on("close", () => {
    connecting = false;
    ws = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (disabled) return;
  const t = setTimeout(connect, reconnectDelay);
  t.unref?.();
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function flush() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (outbox.length) {
    const msg = outbox.shift()!;
    try {
      ws.send(msg);
    } catch {
      outbox.unshift(msg);
      return;
    }
  }
}

export function notify(n: Notify): void {
  if (disabled) return;
  // Limite anti-runaway: se o broker está fora há tempo e a outbox cresceu,
  // descarta as mais antigas (eventos antigos são irrelevantes).
  if (outbox.length > 200) outbox = outbox.slice(-100);
  outbox.push(JSON.stringify({ ts: Date.now(), ...n }));
  if (!ws) connect();
  else flush();
}

export function disableNotifier() {
  disabled = true;
  try { ws?.close(); } catch {}
  ws = null;
  outbox = [];
}
