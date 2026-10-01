import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { readRun } from './store.ts';
import { codexSocket } from './codex-mail.ts';
import { HOSTS, type Address, type Host, type RunMeta } from './types.ts';

type Env = Record<string, string | undefined>;

const herdrTarget = (env: Env): { herdrAgent?: string; herdrSession?: string } =>
  env.HERDR_ENV === '1' && env.HERDR_PANE_ID
    ? { herdrAgent: env.HERDR_PANE_ID, ...(env.HERDR_SESSION ? { herdrSession: env.HERDR_SESSION } : {}) }
    : {};

/** Mailbox id for a host session id, as seen by both the CLI and the hooks. */
export const sessionMailbox = (host: Host, sessionId: string): string => `${host}-${sessionId}`;

export interface Proc { pid: number; ppid: number; comm: string }

/** The calling process's ancestors, nearest first, from one `ps` snapshot. */
export function ancestry(start = process.ppid): Proc[] {
  let table: Map<number, Proc>;
  try {
    table = new Map(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match ? [[Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3]! }] as const] : [];
    }));
  } catch { return []; }
  const chain: Proc[] = [];
  for (let proc = table.get(start); proc && proc.pid > 1 && chain.length < 32; proc = table.get(proc.ppid)) chain.push(proc);
  return chain;
}

/** Optional `crew connect` discovery, restricted to an actual Codex ancestor's explicit listener. */
export function owningCodexSocket(chain = ancestry(), args = (pid: number): string =>
  execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })): string | undefined {
  for (const proc of chain) {
    if (basename(proc.comm) !== 'codex') continue;
    try {
      const match = args(proc.pid).match(/\bapp-server\s+--listen\s+unix:\/\/(\/\S+)(?:\s|$)/);
      if (match) return match[1];
    } catch { /* no process visibility: caller can pass --socket */ }
  }
  return undefined;
}

function hostAncestor(): { host: Host; pid: number } | undefined {
  for (const { pid, comm } of ancestry()) {
    if (basename(comm) === 'claude' || comm.includes('/claude/versions/')) return { host: 'claude', pid };
    if (basename(comm) === 'codex') return { host: 'codex', pid };
    if (basename(comm) === 'opencode' || basename(comm) === '.opencode') return { host: 'opencode', pid };
  }
  return undefined;
}

/**
 * The crew run this session is, if any. CREW_RUN alone is not proof: a long-lived host service
 * (Claude Code's `--bg` daemon) keeps the environment of whichever process started it and hands it
 * to every later session. So once a run has recorded its session, only that session is the run.
 */
export function ownRun(env: Env, sessionId?: string): RunMeta | undefined {
  const run = env.CREW_RUN ? readRun(env.CREW_RUN) : undefined;
  if (!run) return undefined;
  const mine = sessionId ?? env.CREW_OPENCODE_SESSION ?? env.CODEX_THREAD_ID ?? env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID;
  return run.sessionId && mine && run.sessionId !== mine ? undefined : run;
}

const runAddress = (run: RunMeta, env: Env): Address => ({
  mailbox: run.id, host: run.route.host, name: run.name,
  ...(run.threadId ? { threadId: run.threadId } : {}),
  ...(run.herdr ? { herdrAgent: run.herdr.agent, ...(run.herdr.session ? { herdrSession: run.herdr.session } : {}) } : herdrTarget(env)),
});

/**
 * Who is calling crew. Precedence: a crew-spawned run, then the host session id
 * (Codex via CODEX_THREAD_ID, Claude via the SessionStart env file), then process ancestry.
 */
export function self(env: Env = process.env): Address {
  const run = ownRun(env);
  if (run) return runAddress(run, env);
  // crew's OpenCode plugin sets this on every tool shell, so it always names the innermost session.
  if (env.CREW_OPENCODE_SESSION) {
    return { mailbox: sessionMailbox('opencode', env.CREW_OPENCODE_SESSION), host: 'opencode', ...herdrTarget(env) };
  }
  // A Codex tool call always carries its own thread id; a CREW_MAILBOX beside it was inherited
  // from a Claude session that launched this Codex, so the thread id wins.
  if (env.CODEX_THREAD_ID) {
    const mailbox = sessionMailbox('codex', env.CODEX_THREAD_ID);
    const socket = codexSocket(mailbox, env);
    return { mailbox, host: 'codex', threadId: env.CODEX_THREAD_ID, ...(socket ? { codexSocket: socket } : {}), ...herdrTarget(env) };
  }
  if (env.CREW_MAILBOX) {
    const host: Host = HOSTS.find(h => env.CREW_MAILBOX!.startsWith(`${h}-`)) ?? 'claude';
    return { mailbox: env.CREW_MAILBOX, host, ...herdrTarget(env) };
  }
  // Claude Code exports its session id to tool processes (CLI and desktop app alike).
  if (env.CLAUDE_CODE_SESSION_ID) {
    return { mailbox: sessionMailbox('claude', env.CLAUDE_CODE_SESSION_ID), host: 'claude', ...herdrTarget(env) };
  }
  const ancestor = hostAncestor();
  if (ancestor) return { mailbox: `${ancestor.host}-pid-${ancestor.pid}`, host: ancestor.host, ...herdrTarget(env) };
  throw new Error('crew: cannot tell which Claude Code, Codex or OpenCode session is calling; run crew from inside one');
}

/** Identity inside a hook, where the host hands us its session id on stdin. */
export function hookSelf(host: Host, sessionId: string | undefined, env: Env = process.env): Address | undefined {
  const run = ownRun(env, sessionId);
  if (run) return runAddress(run, env);
  if (!sessionId) return undefined;
  const mailbox = sessionMailbox(host, sessionId);
  const socket = host === 'codex' ? codexSocket(mailbox, env) : undefined;
  return { mailbox, host, ...(host === 'codex' ? { threadId: sessionId } : {}), ...(socket ? { codexSocket: socket } : {}), ...herdrTarget(env) };
}
