export const HOSTS = ['claude', 'codex'] as const;
export type Host = (typeof HOSTS)[number];

export const ROLES = ['advisor', 'builder', 'checker'] as const;
export type Role = (typeof ROLES)[number];

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The only thing routing decides. Host is derived from the model, never chosen. */
export interface Route {
  host: Host;
  model: string;
  effort: Effort;
  strategy: 'pinned' | 'jev' | 'fallback' | 'default';
  reason?: string;
}

export type Launcher = 'herdr' | 'bg' | 'exec';

/** Anything that can receive mail: a crew run, or a root session. */
export interface Address {
  mailbox: string;
  host: Host;
  name?: string;
  /** Codex thread to push into via `codex queue`. */
  threadId?: string;
  /** Herdr agent name or pane, when the session lives in a herdr pane. */
  herdrAgent?: string;
}

export type RunState = 'running' | 'done' | 'blocked' | 'failed' | 'stalled' | 'stopped';

export interface RunMeta {
  id: string;
  name: string;
  role: Role;
  route: Route;
  cwd: string;
  keep: boolean;
  parent: Address;
  launcher: Launcher;
  createdAt: string;
  state: RunState;
  herdr?: { pane: string; agent: string; closed?: boolean };
  /** `claude --bg` short id. */
  bgId?: string;
  /** `codex exec` process id. */
  pid?: number;
  /** Learned from the child's SessionStart hook. */
  sessionId?: string;
  threadId?: string;
  settled?: { hash: string; at: string; status: string };
  /** Set while herdr reports the child blocked on a dialog. */
  waitingSince?: string;
}

export type MailKind = 'message' | 'settled' | 'stalled' | 'waiting';

export interface Mail {
  id: string;
  at: string;
  kind: MailKind;
  from: { mailbox: string; name?: string; host?: Host };
  text: string;
  /** Result file for settlement notices. */
  result?: string;
  /** Already shown to the recipient in full by a push (e.g. `codex queue`); readers skip it. */
  pushed?: boolean;
}

export type Delivery = 'waiter' | 'codex-queue' | 'herdr-prompt' | 'queued';

export interface Config {
  /** Role defaults when the Jev router is off or fails; `model@effort`. */
  defaults: Record<Role, string>;
  router: { enabled: boolean; command: string; timeoutMs: number };
  /** Extra CLI args per host, appended to every spawn. Put bypass flags here if you want them. */
  args: Record<Host, string[]>;
  /** Every checkout under these roots is trusted by both CLIs (no folder-trust dialogs). */
  trust: { roots: string[] };
}
