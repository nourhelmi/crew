import { spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentStatus, closePane, prompt, type AgentStatus } from './herdr.ts';
import { self } from './identity.ts';
import { format, reopen, settle, stall, takeUnread, waiting } from './mail.ts';
import { requestResume, resuming } from './resume.ts';
import { readResult } from './result.ts';
import { bgActive, bgSession, ROOT } from './spawn.ts';
import { alive, hasWaiter, listRuns, mailDir, markWaiter, mtime, readRun, resultPath, unread, updateRun, withLock } from './store.ts';
import type { Address, Host, Mail, RunMeta } from './types.ts';

const LIVENESS_EVERY_MS = 5_000;
const BG_EVERY_MS = 20_000;
const BATCH_MS = 750;

type Bg = ReturnType<typeof bgSession>;

/** Why a live child is gone, or undefined while it still runs (or was not checked this sweep). */
function gone(run: RunMeta, herdrStatus: AgentStatus | undefined, bg: Bg | 'unchecked'): string | undefined {
  if (run.launcher === 'herdr') return herdrStatus ? undefined : 'its herdr agent exited';
  if (run.launcher === 'exec') return alive(run.pid) ? undefined : 'codex exec exited';
  if (run.launcher === 'bg' && bg !== 'unchecked') {
    if (bg === 'unknown') return undefined;
    if (!bg) return 'its background session is gone';
    if (['done', 'idle', 'completed'].includes(bg.status ?? '') && bgActive(bg.id, run.launch?.env) === false) return 'its background turn ended';
    // "done" only means idle; a turn that ended without a result is the Stop hook's call.
    return /exit|stop|fail|dead|kill/i.test(bg.status ?? '') ? `its background session is ${bg.status}` : undefined;
  }
  return undefined;
}

function sweep(mailbox: string, checkBg: boolean): void {
  for (const listed of listRuns()) {
    if (listed.parent.mailbox !== mailbox) continue;
    const run = reopen(listed);
    if (run.state !== 'stopped') {
      // Parent-side settlement covers a child whose Stop hook never ran, and a settled child's newer result.
      const result = readResult(resultPath(run.id));
      const hasResult = Boolean(result && result.hash !== run.amendment?.resultHash
        && !unread(run.id).mails.some(mail => mail.kind === 'amendment'));
      if (hasResult) settle(run.id);
      if (run.state === 'running' && !resuming(run.id)) {
        const herdrStatus = run.herdr && !run.herdr.closed ? agentStatus(run.herdr.agent, run.herdr.session) : undefined;
        const bg: Bg | 'unchecked' = run.launcher === 'bg' && checkBg ? bgSession(run.bgId ?? run.sessionId ?? '', run.launch?.env) : 'unchecked';
        // An approval, question or folder-trust dialog needs a human or the parent.
        if (run.launcher === 'herdr' && herdrStatus !== 'unknown') waiting(run.id, herdrStatus === 'blocked');
        if (bg !== 'unchecked' && bg !== 'unknown') waiting(run.id, bg?.status === 'blocked');
        if (unread(run.id).mails.length && run.launcher !== 'herdr') requestResume(readRun(run.id) ?? run);
        if (!hasResult || unread(run.id).mails.length || (run.keep && run.launcher === 'herdr')) {
          const why = gone(run, herdrStatus, bg);
          const lastMail = unread(run.id).mails.at(-1)?.id;
          const needsLaunch = run.launcher !== 'herdr' && run.sessionId && run.launch && lastMail && lastMail !== run.resumedMail;
          if (why && !needsLaunch) stall(run.id, why);
        }
      }
    }
    const fresh = readRun(run.id);
    // Tidy finished, non-kept herdr panes once the agent has gone quiet; failures stay open for inspection.
    if (fresh?.state === 'done' && !fresh.keep && fresh.herdr && !fresh.herdr.closed) {
      const status = agentStatus(fresh.herdr.agent, fresh.herdr.session);
      if (status === 'working' || status === 'blocked' || status === 'unknown') continue;
      if (status && !closePane(fresh.herdr.pane, fresh.herdr.session)) continue;
      updateRun(fresh.id, current => current.state === 'done' && current.herdr
        ? { ...current, herdr: { ...current.herdr, closed: true } } : undefined);
    }
  }
}

/**
 * Block until this session has mail (child settlements, stalls, messages), then print it and exit.
 * On Claude run it as a background Bash command: its exit re-invokes the session.
 */
export async function wait(timeoutMs: number): Promise<Mail[]> {
  const me = self();
  const release = markWaiter(me.mailbox);
  const deadline = Date.now() + timeoutMs;
  let lastSweep = 0;
  let lastBg = 0;
  try {
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now - lastSweep >= LIVENESS_EVERY_MS) {
        const checkBg = now - lastBg >= BG_EVERY_MS;
        sweep(me.mailbox, checkBg);
        lastSweep = now;
        if (checkBg) lastBg = now;
      }
      const mails = takeUnread(me.mailbox);
      if (mails.length) {
        await sleep(BATCH_MS);
        return mails.concat(takeUnread(me.mailbox));
      }
      await sleep(1_000);
    }
    return [];
  } finally {
    release();
  }
}

const watcherFile = (mailbox: string): string => join(mailDir(mailbox), 'watcher');

/**
 * A parent that isn't waiting (a Codex root is doing other work; a Claude root
 * between re-arms) still needs someone to notice a child stuck on a dialog, gone without a
 * result, or settled without its hook. One detached watcher per parent sweeps while no
 * `crew wait` is armed, and exits once the parent has no live children.
 */
export async function watch(mailbox: string, everyMs = LIVENESS_EVERY_MS, maxMs = 24 * 3_600_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  const warm = keepWarm(mailbox);
  let lastBg = 0;
  while (Date.now() < deadline && watched(mailbox).length) {
    if (!hasWaiter(mailbox)) {
      const checkBg = Date.now() - lastBg >= BG_EVERY_MS;
      sweep(mailbox, checkBg);
      if (checkBg) lastBg = Date.now();
      warm();
    }
    await sleep(everyMs);
  }
}

// ---- prompt-cache keepalive ------------------------------------------------------------------
//
// An idle parent's prompt cache expires (Claude Code subscription sessions write 1-hour entries;
// OpenAI's GPT-5.6+/GPT-6 cache lives 30 minutes after its last use), and waking it afterwards
// rewrites its whole context at the write premium. A read refreshes the timer, so a parent that
// isn't waiting gets a one-line nudge shortly before expiry. A Claude root in `crew wait` needs
// none: the wait's 30-minute timeout already wakes it inside the hour.

export const KEEPALIVE = {
  // idle time before a nudge, and how many nudges in a row before one cold rewrite is cheaper
  // No automatic Codex keepalives: queue cannot steer or retract a stale pointer.
  codex: { afterMs: 25 * 60_000, max: 0 },
  claude: { afterMs: 50 * 60_000, max: 16 }, // write 2x vs ~2 reads at 0.05x (Opus 5.5): ~20
  // OpenCode's providers each cache differently (most automatically, for hours); no nudges.
  opencode: { afterMs: 25 * 60_000, max: 0 },
} as const satisfies Record<Host, { afterMs: number; max: number }>;

export const KEEPALIVE_TEXT = '[crew] keepalive: your crew is still working and nothing needs you. '
  + 'Reply "ok" and end your turn (this keeps your prompt cache warm).';

/** Nudge now? `nudges` counts consecutive keepalives since the parent last had real news. */
export function keepaliveDue(host: Host, idleMs: number, nudges: number): boolean {
  return idleMs >= KEEPALIVE[host].afterMs && nudges < KEEPALIVE[host].max;
}

/** The host transcript a session appends to on every event: its mtime is the last activity. */
export function transcriptPath(parent: Address, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sessionId = readRun(parent.mailbox)?.sessionId ?? parent.mailbox.replace(/^(claude|codex)-/, '');
  const find = (dir: string, depth: number, match: (name: string) => boolean): string | undefined => {
    let names: string[];
    try { names = readdirSync(dir).sort().reverse(); } catch { return undefined; }
    for (const name of names) {
      if (depth === 0) { if (match(name)) return join(dir, name); continue; }
      const hit = find(join(dir, name), depth - 1, match);
      if (hit) return hit;
    }
    return undefined;
  };
  if (parent.host === 'opencode') return undefined;
  if (parent.host === 'codex') {
    return find(join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'), 3, name => name.endsWith(`-${sessionId}.jsonl`));
  }
  return find(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'), 1, name => name === `${sessionId}.jsonl`);
}

function keepWarm(mailbox: string): () => void {
  const parent = listRuns().find(run => run.parent.mailbox === mailbox)?.parent;
  if (!parent) return () => {};
  const inbox = join(mailDir(mailbox), 'inbox.jsonl');
  const size = (): number => { try { return statSync(inbox).size; } catch { return 0; } };
  let transcript: string | undefined;
  let looked = 0;
  let nudges = 0;
  let nudgedAt = 0;
  let seen = size();
  return () => {
    if (size() !== seen) { seen = size(); nudges = 0; } // real news: the next quiet stretch starts fresh
    if (!transcript && Date.now() - looked > 60_000) { looked = Date.now(); transcript = transcriptPath(parent); }
    const last = transcript ? mtime(transcript) : undefined;
    if (last === undefined || !keepaliveDue(parent.host, Date.now() - Math.max(last, nudgedAt), nudges)) return;
    const pushed = parent.herdrAgent && agentStatus(parent.herdrAgent, parent.herdrSession) === 'idle'
        ? prompt(parent.herdrAgent, KEEPALIVE_TEXT, parent.herdrSession).ok : false;
    if (pushed) { nudges++; nudgedAt = Date.now(); }
  };
}

export function ensureWatcher(mailbox: string): void {
  withLock(`watch-${mailbox}`, () => {
    try { if (alive(Number(readFileSync(watcherFile(mailbox), 'utf8')))) return; } catch { /* none yet */ }
    mkdirSync(mailDir(mailbox), { recursive: true }); // a parent that has never had mail has no mailbox yet
    const child = spawnProcess(join(ROOT, 'bin', 'crew'), ['watch', mailbox], { detached: true, stdio: 'ignore' });
    child.unref();
    if (child.pid) writeFileSync(watcherFile(mailbox), String(child.pid));
  });
}

/**
 * How a parent hears about its live children. A Claude parent must hold `crew wait` as a
 * background Bash command: that is what lists the work as a background task and wakes the session.
 * Codex parents wait within their current turn; OpenCode's plugin supplies its wake.
 */
export function waitHint(parent: Address): string | undefined {
  const names = liveChildren(parent.mailbox).map(run => run.name);
  if (!names.length) return undefined;
  if (parent.host !== 'claude') return `wake: crew wait (live: ${names.join(', ')})`;
  if (hasWaiter(parent.mailbox)) return `wake: your background crew wait covers ${names.join(', ')}`;
  return `wake: nothing is waiting on ${names.join(', ')}. Start \`crew wait\` now as a background Bash command`
    + ` (run_in_background, description "crew: ${names.join(', ')}"): it lists them as a background task and wakes you when one settles.`;
}

export function liveChildren(mailbox: string): RunMeta[] {
  return listRuns().filter(run => run.parent.mailbox === mailbox && run.state === 'running');
}

/** Children the watcher keeps sweeping: running ones, and blocked ones still alive to answer. */
function watched(mailbox: string): RunMeta[] {
  return listRuns().filter(run => run.parent.mailbox === mailbox && (run.state === 'running'
    || (run.state !== 'stopped' && run.launch && run.sessionId && unread(run.id).mails.at(-1)?.id !== run.resumedMail && unread(run.id).mails.length)
    || (run.settled?.notice && !run.settled.notified)
    || (run.state === 'done' && !run.keep && run.herdr && !run.herdr.closed)
    || (run.state === 'blocked' && (run.launcher === 'exec' ? alive(run.pid)
      : run.launcher === 'herdr' ? Boolean(run.herdr && !run.herdr.closed && agentStatus(run.herdr.agent, run.herdr.session))
      : false))));
}

export { format };
