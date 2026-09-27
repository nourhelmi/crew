import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStatus, prompt } from './herdr.ts';
import { readResult } from './result.ts';
import { appendMail, findRun, hasWaiter, newId, packetPath, readRun, resultPath, runDir, unread, writeRun } from './store.ts';
import type { Address, Delivery, Host, Mail, RunMeta } from './types.ts';

export function runAddress(run: RunMeta): Address {
  return {
    mailbox: run.id, host: run.route.host, name: run.name,
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.herdr ? { herdrAgent: run.herdr.agent, ...(run.herdr.session ? { herdrSession: run.herdr.session } : {}) } : {}),
  };
}

/** `parent` | run id | run name | raw mailbox (`claude-<session>`, `codex-<thread>`). */
export function resolve(ref: string, me: Address): Address {
  if (ref === 'parent') {
    const run = readRun(me.mailbox);
    if (!run) throw new Error('crew: this session has no crew parent (it is a root)');
    return run.parent;
  }
  const run = findRun(ref);
  if (run) return runAddress(run);
  const raw = ref.match(/^(claude|codex)-(.+)$/);
  if (raw) {
    const host = raw[1] as Host;
    const id = raw[2]!;
    return { mailbox: ref, host, ...(host === 'codex' && !id.startsWith('pid-') ? { threadId: id } : {}) };
  }
  throw new Error(`crew: no run, name or mailbox matches "${ref}" (see crew ls)`);
}

const label = (from: Mail['from']): string => from.name ?? from.mailbox;

/** One line that wakes the recipient; the inbox carries the content, so nothing stale is replayed. */
function pointer(mail: Mail): string {
  const who = label(mail.from);
  const what = mail.kind === 'message' ? `new message from ${who}` : mail.kind === 'amendment' ? `packet amendment from ${who}` : `${who} ${mail.kind}`;
  return `[crew] ${what}. Run: crew inbox`;
}

/** A wake pushed this recently and still unread covers later mail too: one push per batch. */
const WAKE_COVERS_MS = 10 * 60_000;
function wakePending(mailbox: string): boolean {
  return unread(mailbox).mails.some(mail => mail.pushed && Date.now() - Date.parse(mail.at) < WAKE_COVERS_MS);
}

function codexQueue(threadId: string, text: string): boolean {
  try {
    execFileSync('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 20_000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * The inbox is the source of truth; pushes only wake the recipient.
 * Ladder: an armed `crew wait` sees it within a second; else push into a Codex
 * thread; else type a one-line pointer into an idle herdr agent; else it waits
 * for the recipient's next `crew wait`, `crew inbox` or Stop hook.
 */
export function deliver(to: Address, mail: Mail): Delivery {
  if (hasWaiter(to.mailbox)) { appendMail(to.mailbox, mail); return 'waiter'; }
  if (wakePending(to.mailbox)) { appendMail(to.mailbox, mail); return 'queued'; }
  if (to.host === 'codex' && to.threadId && codexQueue(to.threadId, pointer(mail))) {
    appendMail(to.mailbox, { ...mail, pushed: true });
    return 'codex-queue';
  }
  if (to.herdrAgent) {
    const status = agentStatus(to.herdrAgent, to.herdrSession);
    if ((status === 'idle' || status === 'done') && prompt(to.herdrAgent, pointer(mail), to.herdrSession).ok) {
      appendMail(to.mailbox, { ...mail, pushed: true });
      return 'herdr-prompt';
    }
  }
  appendMail(to.mailbox, mail);
  return 'queued';
}

export function send(from: Address, to: Address, text: string, kind: 'message' | 'amendment' = 'message'): Delivery {
  return deliver(to, {
    id: newId('m'), at: new Date().toISOString(), kind,
    from: { mailbox: from.mailbox, host: from.host, ...(from.name ? { name: from.name } : {}) }, text,
  });
}

/**
 * Scope, authorization and done-when changes go into the child's packet, never only into
 * mail: children treat plain messages as advice. Only the run's parent may amend it.
 */
export function amend(from: Address, runRef: string, text: string): { run: RunMeta; number: number; delivery: Delivery } {
  const run = findRun(runRef);
  if (!run) throw new Error(`crew: no run matches "${runRef}" (see crew ls)`);
  if (run.parent.mailbox !== from.mailbox) throw new Error(`crew: only ${run.name}'s parent can amend its packet; send advice with crew msg`);
  const packet = packetPath(run.id);
  const number = (readFileSync(packet, 'utf8').match(/^## Amendment \d+/gm)?.length ?? 0) + 1;
  appendFileSync(packet, `\n## Amendment ${number} (${new Date().toISOString()})\n\n${text.trim()}\n`);
  return { run, number, delivery: send(from, runAddress(run), `Amendment ${number} (appended to ${packet}):\n${text.trim()}`, 'amendment') };
}

const fromRun = (run: RunMeta): Mail['from'] => ({ mailbox: run.id, name: run.name, host: run.route.host });

/** First caller wins: the child's Stop hook and the parent's sweep race to report the same event. */
function claim(id: string, event: string): boolean {
  try { writeFileSync(join(runDir(id), `.${event}`), '', { flag: 'wx' }); return true; }
  catch { return false; }
}

/** Tell the parent about a (new) terminal result. Idempotent per result content. */
export function settle(id: string): Delivery | undefined {
  const status = readResult(resultPath(id));
  if (!status) return undefined;
  const run = readRun(id);
  if (!run || run.settled?.hash === status.hash || !claim(id, `settled-${status.hash}`)) return undefined;
  const fresh: RunMeta = {
    ...run,
    state: run.keep ? run.state : status.verdict,
    settled: { hash: status.hash, at: new Date().toISOString(), status: status.line },
  };
  writeRun(fresh);
  return deliver(fresh.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'settled', from: fromRun(fresh),
    text: `${fresh.role} on ${fresh.route.model}@${fresh.route.effort}: ${status.line}`, result: resultPath(id),
  });
}

/** A kept teammate ended a turn mid-assignment twice in a row. Reported once per status line. */
export function paused(id: string, line: string): Delivery | undefined {
  const run = readRun(id);
  if (!run || !claim(id, `paused-${createHash('sha256').update(line).digest('hex').slice(0, 16)}`)) return undefined;
  return deliver(run.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'waiting', from: fromRun(run),
    text: `paused mid-assignment (${line}); resume it with crew msg ${run.name} "..." or amend its packet`,
  });
}

/** A child that disappeared without a terminal result. Reported once. */
export function stall(id: string, why: string): Delivery | undefined {
  const run = readRun(id);
  if (!run || run.state !== 'running' || !claim(id, 'stalled')) return undefined;
  const fresh: RunMeta = { ...run, state: 'stalled' };
  writeRun(fresh);
  return deliver(fresh.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'stalled', from: fromRun(fresh),
    text: readResult(resultPath(id)) ? `${why} (last result: ${resultPath(id)})` : `${why}; no terminal result at ${resultPath(id)}`,
  });
}

/** A child stuck on an approval/question dialog in its pane. Reported once per episode. */
export function waiting(id: string, blocked: boolean): Delivery | undefined {
  const run = readRun(id);
  if (!run || Boolean(run.waitingSince) === blocked) return undefined;
  const { waitingSince: _, ...rest } = run;
  writeRun(blocked ? { ...rest, waitingSince: new Date().toISOString() } : rest);
  if (!blocked) return undefined;
  return deliver(run.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'waiting', from: fromRun(run),
    text: run.bgId
      ? `is waiting on an approval, question or folder-trust dialog in background session ${run.bgId} (answer it: claude attach ${run.bgId})`
      : `is waiting on an approval, question or folder-trust dialog in herdr pane ${run.herdr?.pane ?? '?'} (look: crew read ${run.name})`,
  });
}

/** Unread mail minus what a push already showed in full. */
export function takeUnread(mailbox: string): Mail[] {
  const { mails, commit } = unread(mailbox);
  commit();
  return mails;
}

export function format(mail: Mail): string {
  const who = label(mail.from);
  if (mail.kind === 'message') return `[message] from ${who}:\n${mail.text}`;
  if (mail.kind === 'amendment') return `[amendment] from ${who} (part of your packet):\n${mail.text}`;
  return `[${mail.kind}] ${who}: ${mail.text}${mail.result ? `\n  result: ${mail.result}` : ''}`;
}
