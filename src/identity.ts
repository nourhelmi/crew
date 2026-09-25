import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { readRun } from './store.ts';
import type { Address, Host } from './types.ts';

type Env = Record<string, string | undefined>;

const herdrTarget = (env: Env): { herdrAgent?: string } =>
  env.HERDR_ENV === '1' && env.HERDR_PANE_ID ? { herdrAgent: env.HERDR_PANE_ID } : {};

/** Mailbox id for a host session id, as seen by both the CLI and the hooks. */
export const sessionMailbox = (host: Host, sessionId: string): string => `${host}-${sessionId}`;

function hostAncestor(): { host: Host; pid: number } | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    let line: string;
    try { line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
    catch { return undefined; }
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) return undefined;
    const comm = match[2]!;
    if (basename(comm) === 'claude' || comm.includes('/claude/versions/')) return { host: 'claude', pid };
    if (basename(comm) === 'codex') return { host: 'codex', pid };
    pid = Number(match[1]);
  }
  return undefined;
}

/**
 * Who is calling crew. Precedence: a crew-spawned run, then the host session id
 * (Claude via the SessionStart env file, Codex via CODEX_THREAD_ID), then process ancestry.
 */
export function self(env: Env = process.env): Address {
  const run = env.CREW_RUN ? readRun(env.CREW_RUN) : undefined;
  if (run) {
    return {
      mailbox: run.id, host: run.route.host, name: run.name,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.herdr ? { herdrAgent: run.herdr.agent } : herdrTarget(env)),
    };
  }
  if (env.CREW_MAILBOX) {
    const host: Host = env.CREW_MAILBOX.startsWith('codex-') ? 'codex' : 'claude';
    return { mailbox: env.CREW_MAILBOX, host, ...herdrTarget(env) };
  }
  if (env.CODEX_THREAD_ID) {
    return { mailbox: sessionMailbox('codex', env.CODEX_THREAD_ID), host: 'codex', threadId: env.CODEX_THREAD_ID, ...herdrTarget(env) };
  }
  // Claude Code exports its session id to tool processes (CLI and desktop app alike).
  if (env.CLAUDE_CODE_SESSION_ID) {
    return { mailbox: sessionMailbox('claude', env.CLAUDE_CODE_SESSION_ID), host: 'claude', ...herdrTarget(env) };
  }
  const ancestor = hostAncestor();
  if (ancestor) return { mailbox: `${ancestor.host}-pid-${ancestor.pid}`, host: ancestor.host, ...herdrTarget(env) };
  throw new Error('crew: cannot tell which Claude Code or Codex session is calling; run crew from inside one');
}

/** Identity inside a hook, where the host hands us its session id on stdin. */
export function hookSelf(host: Host, sessionId: string | undefined, env: Env = process.env): Address | undefined {
  if (env.CREW_RUN && readRun(env.CREW_RUN)) return self(env);
  if (!sessionId) return undefined;
  return { mailbox: sessionMailbox(host, sessionId), host, ...(host === 'codex' ? { threadId: sessionId } : {}), ...herdrTarget(env) };
}
