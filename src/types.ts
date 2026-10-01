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
  strategy: 'pinned' | 'jev' | 'fallback' | 'default' | 'overflow';
  reason?: string;
}

export type Launcher = 'herdr' | 'bg' | 'exec';

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
  herdr?: { pane: string; agent: string; session?: string; closed?: boolean };
  /** `claude --bg` short id. */
  bgId?: string;
  /** `codex exec` process id. */
  pid?: number;
  /** Learned from the child's SessionStart hook. */
  sessionId?: string;
  threadId?: string;
  /** The original launch inputs, excluding credentials; resumes retain model, access and routing. */
  launch?: { args: string[]; env: Record<string, string> };
  /** Competing resume requests target the same turn generation. */
  turn?: number;
  /** Last mail batch for which a headless turn actually launched; failed turns need new mail or explicit resume. */
  resumedMail?: string;
  settled?: { hash: string; at: string; status: string; notice?: Mail; notified?: boolean };
  /** An amendment requires a fresh result, even after the child consumes its inbox. */
  amendment?: { number: number; resultHash?: string };
  /** Set while herdr reports the child blocked on a dialog. */
  waitingSince?: string;
  /** Checker only: the run whose work it reviews; its verdict becomes routing evidence for that run. */
  checks?: string;
  /** The parent's verdict on this run's work (`crew grade`). */
  grade?: { good: boolean; at: string; note?: string };
}

export type MailKind = 'message' | 'amendment' | 'settled' | 'reopened' | 'stalled' | 'waiting';

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
  /**
   * Opt-in per-host cap on live crew runs. They share one subscription's rate limits, which a
   * point-in-time router can't see being burned. A routed spawn over the cap goes to `overflow`.
   */
  capacity: Partial<Record<Host, { max: number; overflow: string }>>;
}
