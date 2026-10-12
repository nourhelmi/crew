import type { OwnedProcess } from './console-process.ts';

export const HOSTS = ['claude', 'codex', 'opencode'] as const;
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

export type Launcher = 'herdr' | 'bg' | 'exec' | 'console' | 't3';

/** Anything that can receive mail: a crew run, or a root session. */
export interface Address {
  mailbox: string;
  host: Host;
  name?: string;
  /** Codex thread identity; queue is not used for automatic mail delivery. */
  threadId?: string;
  /** Explicit owning app-server Unix socket. Only loaded root sessions accept direct mail. */
  codexSocket?: string;
  /** Herdr agent name or pane, when the session lives in a herdr pane. */
  herdrAgent?: string;
  /** The herdr session that pane belongs to; every herdr call for it must target this session. */
  herdrSession?: string;
}

export type RunState = 'idle' | 'running' | 'done' | 'blocked' | 'failed' | 'stalled' | 'stopped';

export interface Acceptance {
  submission: string;
  at: string;
  by: string;
}

export interface Submission {
  ref: string;
  hash: string;
  packetHash: string;
  revision: number;
  at: string;
  status: string;
  result: string;
  accepted?: Acceptance;
}

export interface Assignment {
  id: string;
  revision: number;
  createdAt: string;
  status: 'active' | 'submitted' | 'accepted';
  submission?: string;
  submissions: Submission[];
  accepted?: Acceptance;
}

export interface RunMeta {
  id: string;
  name: string;
  role: Role;
  route: Route;
  cwd: string;
  keep: boolean;
  parent: Address;
  launcher: Launcher;
  /** Verified console ancestry and a dedicated native provider supervisor. */
  console?: { sessionId: string; rootSessionId: string };
  /** Native T3 child identity, cross-checked by the authenticated owning bridge. */
  t3?: { threadId: string; taskId: string };
  /** A pending native launch keeps its idempotency key across uncertain bridge outcomes. */
  t3Request?: { action: 'start' | 'resume'; requestId: string; mailId?: string; priorMail?: string };
  /** Confirmed native retirement permits deleting the private bridge credential snapshot. */
  t3Stopped?: boolean;
  createdAt: string;
  state: RunState;
  herdr?: { pane: string; agent: string; session?: string; closed?: boolean };
  /** `claude --bg` short id. */
  bgId?: string;
  /** `codex exec` process id. */
  pid?: number;
  /** Launch-time PID identity for safe cancellation of detached exec tool descendants. */
  ownedProcess?: OwnedProcess;
  /** Learned from the child's SessionStart hook. */
  sessionId?: string;
  threadId?: string;
  /** The original launch inputs, excluding credentials; resumes retain model, access and routing. */
  launch?: { args: string[]; env: Record<string, string> };
  /** Competing resume requests target the same turn generation. */
  turn?: number;
  /** Last mail batch for which a headless turn actually launched; failed turns need new mail or explicit resume. */
  resumedMail?: string;
  assignment?: Assignment;
  assignmentHistory?: Assignment[];
  settled?: { ref?: string; hash: string; at: string; status: string; notice?: Mail; notified?: boolean };
  /** An amendment requires a fresh result, even after the child consumes its inbox. */
  amendment?: { number: number; resultHash?: string };
  /** Set while herdr reports the child blocked on a dialog. */
  waitingSince?: string;
  /** Checker only: the run whose work it reviews; its verdict becomes routing evidence for that run. */
  checks?: string;
  /** The parent's verdict on this run's work (`crew grade`). */
  grade?: { good: boolean; at: string; note?: string };
}

export type MailKind = 'message' | 'assignment' | 'amendment' | 'settled' | 'reopened' | 'stalled' | 'waiting';

export interface Mail {
  id: string;
  at: string;
  kind: MailKind;
  from: { mailbox: string; name?: string; host?: Host };
  text: string;
  /** Result file for settlement notices. */
  result?: string;
  /** Legacy persisted wake coverage; current deliveries record wake.json instead. */
  pushed?: boolean;
}

export type Delivery = 'waiter' | 'opencode-plugin' | 'herdr-prompt' | 'headless-resume' | 'codex-steer' | 'codex-start' | 'queued';

export interface Config {
  /** Role defaults when the Jev router is off or fails; `model@effort`. */
  defaults: Record<Role, string>;
  router: { enabled: boolean; command: string; timeoutMs: number };
  /** Extra CLI args per host, appended to every spawn. Put bypass flags here if you want them. */
  args: Record<Host, string[]>;
  /** Opt-in: every checkout under these roots is trusted by both CLIs (no folder-trust dialogs). */
  trust: { roots: string[] };
}
