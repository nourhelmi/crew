import type { McpServer } from './mcp-config.ts';

/** Public client contract. Host process handles, credentials and raw RPC stay server-side. */
export type ConsoleHost = 'codex' | 'claude';
export type ConsoleMode = 'cos' | 'advisor';
export type ConsoleAccess = 'default' | 'workspace' | 'full';
export type ConsoleState = 'starting' | 'running' | 'idle' | 'waiting' | 'interrupted' | 'disconnected' | 'failed' | 'closed';
export type CommandState = 'queued' | 'delivered' | 'failed' | 'uncertain';

export interface ConsoleCapabilities {
  /** Omitted by older adapters; the console bootstrap advertises only honest host access modes. */
  accessModes?: ConsoleAccess[];
  activeInput: 'steer' | 'queue';
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
}

export interface ConsoleProvider {
  id: ConsoleHost;
  label: string;
  available: boolean;
  reason?: string;
  models: { id: string; label: string; efforts?: string[] }[];
  defaultModel?: string;
  capabilities: ConsoleCapabilities;
}

export interface ConsoleSession {
  id: string;
  title: string;
  cwd: string;
  mode: ConsoleMode;
  host: ConsoleHost;
  model?: string;
  effort?: string;
  access: ConsoleAccess;
  state: ConsoleState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Link to the managed root in the existing dashboard tree, including before delegation. */
  rootNodeId: string;
  capabilities: ConsoleCapabilities;
  pendingRequests: number;
  error?: string;
}

export interface ConsoleCommand {
  requestId: string;
  state: CommandState;
  error?: string;
}

export type ConsoleRequest = {
  id: string;
  kind: 'approval';
  title: string;
  description: string;
  options: { id: string; label: string }[];
} | {
  id: string;
  kind: 'question';
  title: string;
  questions: {
    id: string;
    question: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
};

export type ConsoleEvent = {
  id: string;
  sequence: number;
  at: string;
} & (
  | { kind: 'user'; text: string; command?: ConsoleCommand }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; title: string; text: string; state: 'running' | 'completed' | 'failed' }
  | { kind: 'status'; text: string }
);

export interface ConsoleDetail {
  session: ConsoleSession;
  events: ConsoleEvent[];
  requests: ConsoleRequest[];
  /** Recent public delivery outcomes, including actions/answers without chat rows. */
  commands?: ConsoleCommand[];
  /** Opaque cursor for older conversation events; absence means all available history is shown. */
  before?: string;
}

export interface ConsoleBootstrap {
  /** Same-origin capability; send in X-Crew-Token for every mutation, never in a URL. */
  token: string;
  providers: ConsoleProvider[];
  projects: { cwd: string; name: string }[];
  sessions: ConsoleSession[];
}

/** Appended to the existing dashboard SSE update. The observer remains read-only. */
export interface ConsoleUpdate {
  sessions: ConsoleSession[];
  detail: ConsoleDetail | null;
  team?: ConsoleTeam | null;
  childDetail?: ConsoleChildDetail | null;
}

/** Native provider state is independent of packet settlement/acceptance. */
export interface ConsoleChild {
  runId: string;
  rootSessionId: string;
  title: string;
  role: 'advisor' | 'builder' | 'checker';
  host: 'codex' | 'claude' | 'opencode';
  model: string;
  effort: string;
  cwd: string;
  keep: boolean;
  parentRunId?: string;
  managed: boolean;
  state: ConsoleState;
  runState: 'running' | 'idle' | 'stalled' | 'done' | 'failed' | 'blocked' | 'stopped';
  assignmentState?: 'active' | 'submitted' | 'accepted';
  revision: number;
  capabilities: ConsoleCapabilities;
  pendingRequests: number;
  error?: string;
}
export interface ConsoleTeam {
  sessionId: string;
  children: ConsoleChild[];
  pendingRequests: { runId: string; request: ConsoleRequest }[];
}
export interface ConsoleChildDetail extends Omit<ConsoleDetail, 'session'> { child: ConsoleChild }
export interface ConsoleChildMutation { child: ConsoleChild; command: ConsoleCommand }
export interface ConsoleChildAction extends Omit<ConsoleAction, 'action'> { action: 'interrupt' | 'resume' | 'stop' }
/** Append/update records, not truncated transcript snapshots. Cursors are session-bound. */
export type ConsoleChange =
  | { kind: 'event'; event: ConsoleEvent }
  | { kind: 'session'; session: ConsoleSession }
  | { kind: 'requests'; requests: ConsoleRequest[] }
  | { kind: 'command'; command: ConsoleCommand };
export interface ConsoleFeed {
  cursor: string;
  changes: (ConsoleChange & { cursor: string })[];
  more: boolean;
  /** A reset/recovery cannot reconstruct history that predates the journal. */
  gap?: { reason: 'expired' | 'invalid' | 'legacy' | 'interrupted-write' };
}

export interface ConsoleLaunch {
  requestId: string;
  title?: string;
  cwd: string;
  mode: ConsoleMode;
  host: ConsoleHost;
  model?: string;
  effort?: string;
  access?: ConsoleAccess;
  prompt: string;
  /** Private launch configuration; never copied into a public session. */
  mcpServers?: McpServer[];
}

export interface ConsoleMessage {
  requestId: string;
  text: string;
  /** Claude queues active input; an explicit interrupt-and-send is available on both hosts. */
  interrupt?: boolean;
}

export type ConsoleAction = {
  requestId: string;
  action: 'interrupt' | 'resume' | 'suspend' | 'close';
  revision: number;
};

export interface ConsoleAnswer {
  requestId: string;
  pendingRequestId: string;
  option?: string;
  answers?: Record<string, string | string[]>;
}

export interface ConsoleMutation {
  session: ConsoleSession;
  command: ConsoleCommand;
}
