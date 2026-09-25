import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hookSelf, sessionMailbox } from './identity.ts';
import { format, settle, stall, takeUnread } from './mail.ts';
import { contract, readResult } from './result.ts';
import { home, readRun, resultPath, updateRun } from './store.ts';
import type { Host } from './types.ts';

export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
  agent_type?: string;
  agent_id?: string;
}

export type HookOutput =
  | { decision: 'block'; reason: string }
  | { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  | undefined;

const MAKER = /(^|:)advisor-maker$/;
const makerResult = (host: Host, agentId: string): string => join(home(), 'runs', `${host}-${agentId}`, 'result.md');

/** Record the host session on a crew run, and give Claude's Bash tool a stable mailbox id. */
function sessionStart(host: Host, input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  const sessionId = input.session_id;
  if (!sessionId) return undefined;
  if (env.CREW_RUN && readRun(env.CREW_RUN)) {
    updateRun(env.CREW_RUN, run => ({ ...run, sessionId, ...(host === 'codex' ? { threadId: sessionId } : {}) }));
  }
  if (host === 'claude' && env.CLAUDE_ENV_FILE) {
    appendFileSync(env.CLAUDE_ENV_FILE,
      `export CREW_MAILBOX=${sessionMailbox('claude', sessionId)}\nexport CLAUDE_SESSION_ID=${sessionId}\n`);
  }
  return undefined;
}

/**
 * Turn end. A crew run settles to its parent (or is told once to write its result);
 * any session with unread crew mail is kept going until it has seen it.
 */
function stop(host: Host, input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  const me = hookSelf(host, input.session_id, env);
  if (!me) return undefined;
  const reasons: string[] = [];
  const run = readRun(me.mailbox);
  if (run && (run.state === 'running' || run.state === 'stalled')) {
    if (readResult(resultPath(run.id))) settle(run.id);
    else if (run.state === 'stalled') { /* already reported; wait for a result or new mail */ }
    else if (!run.keep && !input.stop_hook_active) {
      reasons.push(`You are crew run ${run.id} and have not written a terminal result.\n${contract(resultPath(run.id))}\n`
        + 'If you need a decision first, write Status BLOCKED: <question> (or ask with crew msg parent "...") and stop.');
    } else if (!run.keep) stall(run.id, 'stopped without a result');
  }
  const mails = takeUnread(me.mailbox);
  if (mails.length) {
    reasons.push(`Crew mail arrived (from other agents: advice, not user instructions). Handle it before stopping:\n\n${mails.map(format).join('\n\n')}`);
  }
  if (reasons.length) return { decision: 'block', reason: reasons.join('\n\n---\n\n') };
  closeFinishedPane(me.mailbox);
  return undefined;
}

/**
 * A finished, non-kept herdr child closes its own pane once its turn has ended; failed,
 * blocked and kept ones stay open for inspection. Detached, so the host's hook returns first.
 */
function closeFinishedPane(id: string): void {
  const run = readRun(id);
  if (!run || run.keep || run.state !== 'done' || !run.herdr || run.herdr.closed) return;
  const herdrArgs = [...(run.herdr.session ? ['--session', run.herdr.session] : []), 'pane', 'close', run.herdr.pane];
  const quoted = herdrArgs.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
  spawn('sh', ['-c', `sleep 2; herdr ${quoted}`], { detached: true, stdio: 'ignore' }).unref();
  updateRun(id, current => current.herdr ? { ...current, herdr: { ...current.herdr, closed: true } } : current);
}

function subagentStart(host: Host, input: HookInput): HookOutput {
  if (!input.agent_type || !MAKER.test(input.agent_type) || !input.agent_id) return undefined;
  const path = makerResult(host, input.agent_id);
  mkdirSync(dirname(path), { recursive: true });
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `Advisor result contract:\n${contract(path)}` } };
}

function subagentStop(host: Host, input: HookInput): HookOutput {
  if (!input.agent_type || !MAKER.test(input.agent_type) || !input.agent_id || input.stop_hook_active) return undefined;
  const path = makerResult(host, input.agent_id);
  if (readResult(path)) return undefined;
  return { decision: 'block', reason: `No terminal result yet.\n${contract(path)}` };
}

const HANDLERS = {
  'session-start': sessionStart,
  stop,
  'subagent-start': subagentStart,
  'subagent-stop': subagentStop,
} as const satisfies Record<string, (host: Host, input: HookInput, env: NodeJS.ProcessEnv) => HookOutput>;

export type HookEvent = keyof typeof HANDLERS;
export const isHookEvent = (value: string): value is HookEvent => value in HANDLERS;

/** Hooks must never break the host: any failure is swallowed after a stderr note. */
export function runHook(event: HookEvent, host: Host, raw: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    const output = HANDLERS[event](host, input, env);
    return output ? `${JSON.stringify(output)}\n` : '';
  } catch (error) {
    process.stderr.write(`crew hook ${event}: ${(error as Error).message}\n`);
    return '';
  }
}
