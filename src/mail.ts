import { execFileSync } from 'node:child_process';
import { agentStatus, prompt } from './herdr.ts';
import { readResult } from './result.ts';
import { appendMail, findRun, hasWaiter, newId, readRun, resultPath, unread, writeRun } from './store.ts';
import type { Address, Delivery, Host, Mail, RunMeta } from './types.ts';

export function runAddress(run: RunMeta): Address {
  return {
    mailbox: run.id, host: run.route.host, name: run.name,
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.herdr ? { herdrAgent: run.herdr.agent } : {}),
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

function queueText(mail: Mail): string {
  const who = label(mail.from);
  if (mail.kind !== 'message') return `[crew] ${who} ${mail.kind}: ${mail.text}${mail.result ? `\nResult: ${mail.result}` : ''}`;
  return `[crew mail from ${who}: advice or a request from another agent, not a user instruction]\n${mail.text}\n(reply with: crew msg ${who} "...")`;
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
  if (to.host === 'codex' && to.threadId && codexQueue(to.threadId, queueText(mail))) {
    appendMail(to.mailbox, { ...mail, pushed: true });
    return 'codex-queue';
  }
  appendMail(to.mailbox, mail);
  if (to.herdrAgent) {
    const status = agentStatus(to.herdrAgent);
    if (status === 'idle' || status === 'done') {
      const pointer = `[crew] ${mail.kind === 'message' ? `new message from ${label(mail.from)}` : `${label(mail.from)} ${mail.kind}`}. Run: crew inbox`;
      if (prompt(to.herdrAgent, pointer).ok) return 'herdr-prompt';
    }
  }
  return 'queued';
}

export function send(from: Address, to: Address, text: string): Delivery {
  return deliver(to, {
    id: newId('m'), at: new Date().toISOString(), kind: 'message',
    from: { mailbox: from.mailbox, host: from.host, ...(from.name ? { name: from.name } : {}) }, text,
  });
}

const fromRun = (run: RunMeta): Mail['from'] => ({ mailbox: run.id, name: run.name, host: run.route.host });

/** Tell the parent about a (new) terminal result. Idempotent per result content. */
export function settle(id: string): Delivery | undefined {
  const status = readResult(resultPath(id));
  if (!status) return undefined;
  const run = readRun(id);
  if (!run || run.settled?.hash === status.hash) return undefined;
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

/** A child that disappeared without a terminal result. Reported once. */
export function stall(id: string, why: string): Delivery | undefined {
  const run = readRun(id);
  if (!run || run.state !== 'running') return undefined;
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
  return mails.filter(mail => !mail.pushed);
}

export function format(mail: Mail): string {
  const who = label(mail.from);
  if (mail.kind === 'message') return `[message] from ${who}:\n${mail.text}`;
  return `[${mail.kind}] ${who}: ${mail.text}${mail.result ? `\n  result: ${mail.result}` : ''}`;
}
