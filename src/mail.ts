import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStatus, prompt } from './herdr.ts';
import { requestResume } from './resume.ts';
import { reviewed } from './outcome.ts';
import { progressLine, readResult } from './result.ts';
import { appendMail, findRun, hasWaiter, mailDir, newId, packetPath, readJson, readRun, resultPath, runDir, unread, updateRun, withLock, writeJson } from './store.ts';
import type { Address, Delivery, Host, Mail, RunMeta } from './types.ts';

export function runAddress(run: RunMeta): Address {
  return {
    mailbox: run.id, host: run.route.host, name: run.name,
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.herdr ? { herdrAgent: run.herdr.agent, ...(run.herdr.session ? { herdrSession: run.herdr.session } : {}) } : {}),
  };
}

/** `parent` | run id | run name | raw mailbox (`claude-<session>`, `codex-<thread>`, `opencode-<session>`). */
export function resolve(ref: string, me: Address): Address {
  if (ref === 'parent') {
    const run = readRun(me.mailbox);
    if (!run) throw new Error('crew: this session has no crew parent (it is a root)');
    return run.parent;
  }
  const run = findRun(ref);
  if (run) return runAddress(run);
  const raw = ref.match(/^(claude|codex|opencode)-(.+)$/);
  if (raw) {
    const host = raw[1] as Host;
    const id = raw[2]!;
    return { mailbox: ref, host, ...(host === 'codex' && !id.startsWith('pid-') ? { threadId: id } : {}) };
  }
  throw new Error(`crew: no run, name or mailbox matches "${ref}" (see crew ls)`);
}

const label = (from: Mail['from']): string => from.name ?? from.mailbox;

/** One line that wakes an idle pane; the inbox carries the content. */
function pointer(mail: Mail): string {
  const who = label(mail.from);
  const what = mail.kind === 'message' ? `new message from ${who}` : mail.kind === 'amendment' ? `packet amendment from ${who}` : `${who} ${mail.kind}`;
  return `[crew] ${what}. Run: crew inbox`;
}

/** A wake pushed this recently and still unread covers later mail too: one push per batch. */
const WAKE_COVERS_MS = 10 * 60_000;
function wakePending(mailbox: string): boolean {
  const wake = readJson<{ id: string; at: number }>(join(mailDir(mailbox), 'wake.json'));
  return unread(mailbox).mails.some(mail => (mail.pushed && Date.now() - Date.parse(mail.at) < WAKE_COVERS_MS)
    || (mail.id === wake?.id && Date.now() - wake.at < WAKE_COVERS_MS));
}

/**
 * The inbox is the source of truth; pushes only wake the recipient.
 * Ladder: an armed `crew wait` sees it within a second; an
 * OpenCode session's own crew plugin watches its inbox and wakes it; else type a one-line pointer
 * into an idle herdr agent; else it waits for the recipient's next `crew wait`, `crew inbox` or
 * Stop hook.
 *
 * Never use `codex queue`, including for roots. It queues a future user turn, not a steer.
 * Reading the inbox cannot cancel that turn: each consumed batch can leave another stale pointer
 * to replay after the work. Root advisors wait in the foreground; their Stop hook drains mail
 * before the current turn ends. Children also hear it through their PostToolUse hooks.
 */
export function deliver(to: Address, mail: Mail): Delivery {
  return withLock(`delivery-${to.mailbox}`, () => {
    const covered = wakePending(to.mailbox);
    // Persist before any wake: an idle recipient can read its inbox immediately.
    const file = join(mailDir(to.mailbox), 'inbox.jsonl');
    let existing = false;
    try { existing = readFileSync(file, 'utf8').split('\n').some(line => { try { return JSON.parse(line).id === mail.id; } catch { return false; } }); } catch { /* first delivery */ }
    if (!existing) appendMail(to.mailbox, mail);
    if (hasWaiter(to.mailbox)) return 'waiter';
    if (covered) return 'queued';
    const delivery = push(to, mail);
    if (delivery === 'herdr-prompt' || delivery === 'headless-resume') {
      writeJson(join(mailDir(to.mailbox), 'wake.json'), { id: mail.id, at: Date.now() });
    }
    return delivery;
  });
}

function push(to: Address, mail: Mail): Delivery {
  const run = readRun(to.mailbox);
  if (run && run.launcher !== 'herdr') return requestResume(run) ? 'headless-resume' : 'queued';
  if (to.host === 'opencode') return 'opencode-plugin';
  if (to.herdrAgent) {
    const status = agentStatus(to.herdrAgent, to.herdrSession);
    if ((status === 'idle' || status === 'done') && prompt(to.herdrAgent, pointer(mail), to.herdrSession).ok) {
      return 'herdr-prompt';
    }
  }
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
  let number = 0;
  let delivery: Delivery = 'queued';
  const amended = updateRun(run.id, current => {
    if (current.state === 'stopped') throw new Error(`crew: ${current.name} is stopped; spawn a new run for new work`);
    number = (readFileSync(packet, 'utf8').match(/^## Amendment \d+/gm)?.length ?? 0) + 1;
    const hash = readResult(resultPath(run.id))?.hash;
    appendFileSync(packet, `\n## Amendment ${number} (${new Date().toISOString()})\n\n${text.trim()}\n`);
    return { ...current, state: 'running', amendment: { number, ...(hash ? { resultHash: hash } : {}) } };
  }) ?? run;
  delivery = send(from, runAddress(amended), `Amendment ${number} (appended to ${packet}):\n${text.trim()}`, 'amendment');
  return { run: amended, number, delivery };
}

const fromRun = (run: RunMeta): Mail['from'] => ({ mailbox: run.id, name: run.name, host: run.route.host });

/** First caller wins: the child's Stop hook and the parent's sweep race to report the same event. */
function claim(id: string, event: string): boolean {
  try { writeFileSync(join(runDir(id), `.${event}`), '', { flag: 'wx' }); return true; }
  catch { return false; }
}

/** A committed completion notice survives later drafts, amendments and explicit stops. */
function flushSettlement(id: string): Delivery | undefined {
  const run = readRun(id);
  if (!run?.settled?.notice || run.settled.notified) return undefined;
  const delivery = deliver(run.parent, run.settled.notice);
  const acknowledged = { ...run.settled, notified: true };
  writeJson(join(runDir(id), `.settled-${run.settled.hash}`), acknowledged);
  updateRun(id, current => current.settled?.hash === run.settled!.hash ? { ...current, settled: acknowledged } : undefined);
  return delivery;
}

/** Tell the parent about a (new) terminal result. Idempotent per result content. */
export function settle(id: string): Delivery | undefined {
  const pendingDelivery = flushSettlement(id);
  const status = readResult(resultPath(id));
  if (!status) return pendingDelivery;
  let fresh: RunMeta | undefined;
  let isNew = false;
  const event = join(runDir(id), `.settled-${status.hash}`);
  updateRun(id, run => {
    if (run.state === 'stopped') return undefined;
    if (run.settled?.hash === status.hash) {
      if (run.settled.notice && !run.settled.notified) fresh = run;
      return undefined;
    }
    if (readResult(resultPath(id))?.hash !== status.hash || run.amendment?.resultHash === status.hash
      || unread(id).mails.some(mail => mail.kind === 'amendment')) return undefined;
    let settled: NonNullable<RunMeta['settled']>;
    try {
      const at = new Date().toISOString();
      settled = { hash: status.hash, at, status: status.line, notice: {
        id: `settled-${id}-${status.hash}`, at, kind: 'settled', from: fromRun(run),
        text: `${run.role} on ${run.route.model}@${run.route.effort}: ${status.line}`, result: resultPath(id),
      } };
      // The claim IS the outbox: if the process dies before metadata, the next sweep replays it.
      writeFileSync(event, JSON.stringify(settled), { flag: 'wx', mode: 0o600 });
      isNew = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { settled = readJson<NonNullable<RunMeta['settled']>>(event)!; } catch { return undefined; } // legacy empty claim
      if (!settled?.notice || settled.notified) return undefined;
    }
    fresh = { ...run, state: run.keep ? 'running' : status.verdict, settled };
    return fresh;
  });
  if (!fresh?.settled?.notice) return pendingDelivery;
  const delivery = deliver(fresh.parent, fresh.settled.notice);
  // Append-once delivery survives a crash after inbox append but before either acknowledgement.
  const acknowledged = { ...fresh.settled, notified: true };
  writeJson(event, acknowledged);
  updateRun(id, current => current.settled?.hash === status.hash ? { ...current, settled: acknowledged } : undefined);
  // No external router command may stand between the durable notice and its parent.
  if (isNew) { try { reviewed(fresh, status); } catch { /* routing evidence is best effort */ } }
  return delivery;
}

/**
 * A settled run whose result is back to IN PROGRESS took more work after settling (usually an
 * amendment). It is running again, so waits, Stop-hook nudges and capacity cover it; its parent
 * hears once per settled result. Returns the run as it now stands.
 */
export function reopen(run: RunMeta): RunMeta {
  if (!run.settled || run.keep || !['done', 'failed', 'blocked'].includes(run.state)) return run;
  const line = progressLine(resultPath(run.id));
  if (!line) return run;
  const fresh = updateRun(run.id, current => current.state === run.state && current.settled?.hash === run.settled?.hash
    && progressLine(resultPath(run.id)) ? { ...current, state: 'running' } : undefined) ?? run;
  if (fresh.state === 'running' && claim(run.id, `reopened-${run.settled.hash}`)) {
    deliver(fresh.parent, {
      id: newId('m'), at: new Date().toISOString(), kind: 'reopened', from: fromRun(fresh),
      text: `is working again after settling ${run.settled.status}: ${line}`,
    });
  }
  return fresh;
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
  let fresh: RunMeta | undefined;
  updateRun(id, run => {
    if (run.state !== 'running' || !claim(id, 'stalled')) return undefined;
    fresh = { ...run, state: 'stalled' };
    return fresh;
  });
  if (!fresh) return undefined;
  return deliver(fresh.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'stalled', from: fromRun(fresh),
    text: readResult(resultPath(id)) ? `${why} (last result: ${resultPath(id)})` : `${why}; no terminal result at ${resultPath(id)}`,
  });
}

/** A child stuck on an approval/question dialog in its pane. Reported once per episode. */
export function waiting(id: string, blocked: boolean): Delivery | undefined {
  let run: RunMeta | undefined;
  updateRun(id, current => {
    if (current.state !== 'running' || Boolean(current.waitingSince) === blocked) return undefined;
    run = current;
    const { waitingSince: _, ...rest } = current;
    return blocked ? { ...rest, waitingSince: new Date().toISOString() } : rest;
  });
  if (!run || !blocked) return undefined;
  return deliver(run.parent, {
    id: newId('m'), at: new Date().toISOString(), kind: 'waiting', from: fromRun(run),
    text: run.bgId
      ? `is waiting on an approval, question or folder-trust dialog in background session ${run.bgId} (answer it: claude attach ${run.bgId})`
      : `is waiting on an approval, question or folder-trust dialog in herdr pane ${run.herdr?.pane ?? '?'} (look: crew read ${run.name})`,
  });
}

/** Consume a batch once, even if a Stop hook and crew wait read concurrently. */
export function takeUnread(mailbox: string): Mail[] {
  return withLock(`consume-${mailbox}`, () => {
    const { mails, commit } = unread(mailbox);
    commit();
    return mails;
  });
}

export function format(mail: Mail): string {
  const who = label(mail.from);
  if (mail.kind === 'message') return `[message] from ${who}:\n${mail.text}`;
  if (mail.kind === 'amendment') return `[amendment] from ${who} (part of your packet):\n${mail.text}`;
  return `[${mail.kind}] ${who}: ${mail.text}${mail.result ? `\n  result: ${mail.result}` : ''}`;
}
