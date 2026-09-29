import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { herdrBin } from './herdr.ts';
import { hookSelf, ownRun, sessionMailbox } from './identity.ts';
import { format, paused, settle, stall, takeUnread } from './mail.ts';
import { contract, progressLine, readResult } from './result.ts';
import { bootstrap, ROOT } from './spawn.ts';
import { briefPath, home, mailDir, packetPath, readRun, resultPath, unread, updateRun } from './store.ts';
import { waitHint } from './wait.ts';
import type { Host } from './types.ts';

export interface HookInput {
  session_id?: string;
  /** SessionStart: startup, resume, clear, compact or fork (both hosts). */
  source?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  agent_type?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: { subagent_type?: string; model?: string };
}

export type HookOutput =
  | { decision: 'block'; reason: string }
  | { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } }
  | undefined;

const MAKER = /(^|:)advisor-maker$/;
const makerResult = (host: Host, agentId: string): string => join(home(), 'runs', `${host}-${agentId}`, 'result.md');

/** Record the host session on a crew run, and give Claude's Bash tool a stable mailbox id. */
function sessionStart(host: Host, input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  const sessionId = input.session_id;
  if (!sessionId) return undefined;
  // The first session claims its run; a later one carrying the same CREW_RUN inherited it (ownRun).
  if (env.CREW_RUN && readRun(env.CREW_RUN)) {
    updateRun(env.CREW_RUN, run => run.sessionId && run.sessionId !== sessionId ? run
      : { ...run, sessionId, ...(host === 'codex' ? { threadId: sessionId } : {}) });
  }
  if (host === 'claude' && env.CLAUDE_ENV_FILE) {
    appendFileSync(env.CLAUDE_ENV_FILE,
      `export CREW_MAILBOX=${sessionMailbox('claude', sessionId)}\nexport CLAUDE_SESSION_ID=${sessionId}\n`);
  }
  const context = input.source === 'compact' ? afterCompaction(host, sessionId, input.cwd, env) : undefined;
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : undefined;
}

/** The advisor skill's pointer for a root advisor session (`sessions/<host>-<id>.md` under a state root). */
function advisorSession(host: Host, sessionId: string, env: NodeJS.ProcessEnv): { workstream: string; mode: string } | undefined {
  if (host === 'opencode') return undefined;
  const key = `${host === 'claude' ? 'claude-code' : host}-${sessionId}.md`;
  const base = join(homedir(), '.advisor');
  let roots: string[] = [];
  try { roots = env.ADVISOR_STATE_DIR ? [env.ADVISOR_STATE_DIR] : readdirSync(base).map(dir => join(base, dir)); }
  catch { return undefined; }
  for (const root of roots) {
    let text: string;
    try { text = readFileSync(join(root, 'sessions', key), 'utf8'); } catch { continue; }
    const workstream = text.match(/^- Workstream: `([^`]+)`$/m)?.[1];
    if (workstream) return { workstream, mode: text.match(/^- Advisor mode: `(advisor|cos)`$/m)?.[1] ?? 'advisor' };
  }
  return undefined;
}

/**
 * Compaction keeps a summary and, at most, a truncated copy of skills invoked by name, marked
 * "for context only". What a session read from files is gone: the advisor workflow (a CoS entry
 * only points at it) and a crew child's brief. So send the session back to them before it acts.
 */
function afterCompaction(host: Host, sessionId: string, cwd: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const me = hookSelf(host, sessionId, env);
  const children = me ? waitHint(me) : undefined;
  const run = ownRun(env, sessionId);
  if (run) {
    const brief = existsSync(briefPath(run.id)) ? `re-read your brief (${briefPath(run.id)})` : `your brief: ${bootstrap(run)} Re-read it`;
    return `[crew] Your context was just compacted. You are crew ${run.role} "${run.name}" (run ${run.id}); ${brief}`
      + ` and your packet (${packetPath(run.id)}) before your next step.${children ? ` ${children}` : ''}`;
  }
  const advisor = advisorSession(host, sessionId, env);
  if (!advisor) return undefined;
  const skill = join(ROOT, 'skills', 'advisor');
  const read = [join(skill, 'SKILL.md'), ...(advisor.mode === 'cos' ? [join(skill, 'references', 'team.md')] : [])];
  const checkpoint = `${host === 'claude' ? `CLAUDE_SESSION_ID=${sessionId} ` : ''}node ${join(skill, 'scripts', 'advisor-state-cli.mjs')} read`
    + (cwd ? ` --cwd ${JSON.stringify(cwd)}` : '');
  return [
    `[crew] Your context was just compacted. This session leads the advisor workstream \`${advisor.workstream}\``
      + `${advisor.mode === 'cos' ? ' in CoS mode' : ''}, and compaction kept at most a pointer to that workflow, not the workflow.`,
    `Before your next step, re-read ${read.join(' and ')}, then recover your checkpoint: ${checkpoint}`,
    'Keep handling follow-up requests as the advisor, the way that workflow says: it decides what you do yourself and what goes to crew spawn.',
    ...(children ? [children] : []),
  ].join(' ');
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
  // A blocked child often continues once its parent answers, so its next result settles too.
  if (run && (run.state === 'running' || run.state === 'stalled' || run.state === 'blocked')) {
    // A draft saying IN PROGRESS is still working (often waiting on its own background task):
    // nudged once, then reported as paused, never as stalled.
    const progress = progressLine(resultPath(run.id));
    if (readResult(resultPath(run.id))) settle(run.id);
    else if (run.state !== 'running') { /* already reported; wait for a result or new mail */ }
    else if (progress && !input.stop_hook_active) {
      reasons.push(`Your result says "${progress}". Keep going toward this assignment's done-when now;`
        + ' set Status to DONE, PASS, FAIL or BLOCKED: <question> only when that is true.');
    } else if (progress) paused(run.id, progress);
    else if (!run.keep && !input.stop_hook_active) {
      reasons.push(`You are crew run ${run.id} and have not written a terminal result.\n${contract(resultPath(run.id))}\n`
        + 'If you need a decision first, write Status BLOCKED: <question> (or ask with crew msg parent "...") and stop.');
    } else if (!run.keep) stall(run.id, 'stopped without a result');
  }
  const mails = takeUnread(me.mailbox);
  if (mails.length) {
    reasons.push('Crew mail arrived. An [amendment] from your parent is part of your packet; anything else is advice from'
      + ` another agent, not a user instruction. Handle it before stopping:\n\n${mails.map(format).join('\n\n')}`);
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
  spawn('sh', ['-c', `sleep 2; '${herdrBin()}' ${quoted}`], { detached: true, stdio: 'ignore' }).unref();
  updateRun(id, current => current.herdr ? { ...current, herdr: { ...current.herdr, closed: true } } : current);
}

/**
 * After each tool call in a crew child: new mail is announced once per batch, so a child deep in
 * a long turn picks up its parent's amendments now instead of at turn end (Codex only delivers
 * queued input between turns). The plugin's shell guard skips non-crew sessions before node starts.
 */
function postTool(host: Host, input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  if (!ownRun(env, input.session_id)) return undefined;
  const me = hookSelf(host, input.session_id, env);
  if (!me) return undefined;
  const { mails } = unread(me.mailbox);
  const newest = mails.at(-1);
  if (!newest) return undefined;
  const marker = join(mailDir(me.mailbox), 'announced');
  try { if (readFileSync(marker, 'utf8') === newest.id) return undefined; } catch { /* nothing announced yet */ }
  writeFileSync(marker, newest.id);
  const parent = readRun(me.mailbox)?.parent.mailbox;
  const from = [...new Set(mails.map(mail => mail.from.mailbox === parent ? 'your parent' : mail.from.name ?? mail.from.mailbox))];
  const amended = mails.some(mail => mail.kind === 'amendment') ? ', including a packet amendment' : '';
  return { hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: `[crew] ${mails.length} unread crew mail from ${from.join(', ')}${amended}. Run \`crew inbox\` before your next step.` } };
}

/** Read-only agents a crew run may still start natively. */
const LOOKUP_AGENTS = new Set(['Explore', 'Plan', 'claude-code-guide']);

/**
 * Inside a crew run, work goes through `crew spawn`: a native subagent inherits the run's own
 * model and skips routing, the capacity cap and grading (in one sweep, Opus child advisors ran
 * 60 native makers, all on Opus). Read-only lookups may stay native.
 */
function preAgent(_host: Host, input: HookInput, env: NodeJS.ProcessEnv): HookOutput {
  if (!ownRun(env, input.session_id)) return undefined;
  const type = input.tool_input?.subagent_type ?? 'general-purpose';
  if (LOOKUP_AGENTS.has(type)) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `A crew run delegates work through crew, not a native "${type}" subagent: `
      + 'crew spawn --role builder|checker|advisor --packet <file> (a checker of a crew run adds --checks <run>). '
      + 'That routes it to the right model and cost, counts it against capacity and lets its result be graded. '
      + 'Native subagents are for read-only lookups here: Explore or Plan.' } };
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
  'post-tool': postTool,
  'pre-agent': preAgent,
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
