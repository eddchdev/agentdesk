export type SessionStatus = "active" | "suspect" | "dead" | "closed";

export interface SessionView {
  id: string;
  name: string;
  agent_name: string | null;
  role: string;
  task: string | null;
  project: string | null;
  folder: string | null;
  areas: string[];
  intended_files: string[];
  opened_at: number;
  last_heartbeat: number;
  status: SessionStatus;
}

export type ChatType = "falar" | "pedir" | "passar" | "alerta" | "decisao" | "erro";

export interface ChatMessageView {
  id: string;
  created_at: number;
  session_id: string;
  session_name: string;
  role: string;
  type: string;
  to_target: string | null;
  task_id: string | null;
  files: string[];
  message: string;
}

export interface LockView {
  id: string;
  session_id: string;
  session_name: string;
  role: string;
  file_path: string;
  kind: string;
  area: string | null;
  created_at: number;
  task_id: string | null;
  task_title: string | null;
}

export interface HandoffView {
  id: string;
  from_session: string;
  from_name: string | null;
  to_target: string;
  task_id: string | null;
  task_title: string | null;
  note: string | null;
  created_at: number;
  accepted: boolean;
  accepted_at: number | null;
}

export interface DelegationView {
  id: string;            // chat_message id
  from_name: string;     // agente que delegou
  from_role: string;     // cargo (geralmente "gerente")
  to_target: string;     // destinatário (nome ou cargo)
  message: string;       // mensagem completa da delegação
  created_at: number;
  seen: boolean;         // se o alvo já viu (last_seen_ms > created_at)
}

export interface WorkItemView {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  assigned_role: string | null;
  owner_agent_name: string | null;
  blocked_reason: string | null;
  delivery_summary: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  updated_at: number;
}

export interface ActivityView {
  session_id: string;
  agent_name: string;
  role: string;
  description: string;   // descrição curta e natural do que o agente está fazendo
  updated_at: number;
  status: SessionStatus;
}

export interface Snapshot {
  now: number;
  sessions: SessionView[];
  chat: ChatMessageView[];
  locks: LockView[];
  handoffs: HandoffView[];
  delegations: DelegationView[];
  workItems: WorkItemView[];
  activities: ActivityView[];
  counts: { active: number; suspect: number; dead: number; closed: number };
}

declare global {
  interface Window {
    agentdesk: {
      snapshot: () => Promise<Snapshot>;
      sendMessage: (to: string | null, message: string, type?: string) => Promise<void>;
    };
    terminal: {
      create: (id: string, name: string, cwd?: string) => Promise<{ ok: boolean }>;
      homedir: () => Promise<string>;
      pickDir: () => Promise<string | null>;
      write: (id: string, data: string) => void;
      resize: (id: string, cols: number, rows: number) => void;
      kill: (id: string) => void;
      onData: (cb: (id: string, data: string) => void) => () => void;
      onExit: (cb: (id: string) => void) => () => void;
    };
  }
}
