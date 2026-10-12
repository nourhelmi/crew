import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeDescendants, candidate, currentAssignment, packetHash, packetMail, snapshot, unaccepted } from './assignment.ts';
import { agentStatus, prompt } from './herdr.ts';
import { requestResume } from './resume.ts';
import { pushCodex, registeredSocket } from './codex-mail.ts';
import { reviewed } from './outcome.ts';
import { progressLine, readResult } from './result.ts';
import { appendMail, changePacket, findRun, hasWaiter, mailDir, newId, packetPath, readJson, readRun, resultPath, runDir, unread, updateRun, withLock, writeJson } from './store.ts';
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
    const socket = host === 'codex' ? registeredSocket(ref) : undefined;
    return { mailbox: ref, host, ...(host === 'codex' && !id.startsWith('pid-') ? { threadId: id } : {}), ...(socket ? { codexSocket: socket } : {}) };
  }
  throw new Error(`crew: no run, name or mailbox matches "${ref}" (see crew ls)`);
}

const label = (from: Mail['from']): string => from.name ?? from.mailbox;

/** One line that wakes an idle pane; the inbox carries the content. */
function pointer(mail: Mail): string {
  const who = label(mail.from);
  const what = mail.kind === 'message' ? `new message from ${who}` : mail.kind === 'assignment' ? `new assignment from ${who}` : mail.kind === 'amendment' ? `packet amendment from ${who}` : `${who} ${mail.kind}`;
  return `[crew] ${what}. Run: crew inbox`;
}

/** An unread wake covers later mail too; Codex attempts never expire into replay. */
const WAKE_COVERS_MS = 10 * 60_000;
function wakePending(mailbox: string): boolean {
  const wake = readJson<{ id: string; at: number; transport?: string }>(join(mailDir(mailbox), 'wake.json'));
  return unread(mailbox).mails.some(mail => (mail.pushed && Date.now() - Date.parse(mail.at) < WAKE_COVERS_MS)
    || (mail.id === wake?.id && (wake.transport === 'codex' || Date.now() - wake.at < WAKE_COVERS_MS)));
}

/**
 * The inbox is the source of truth; pushes only wake the recipient.
 * Ladder: an armed `crew wait` sees it within a second; a loaded Codex root on an explicitly
 * connected Unix server receives an active-turn steer or an immediate idle turn; an
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
  if (!run && to.host === 'codex' && !to.herdrAgent) return pushCodex(to);
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
  const notice: Mail = { id: newId('m'), at: new Date().toISOString(), kind: 'amendment', from, text: '' };
  const amended = updateRun(run.id, current => {
    if (current.state === 'stopped') throw new Error(`crew: ${current.name} is stopped; spawn a new run for new work`);
    const assignment = currentAssignment(current);
    number = assignment.revision + 1;
    const hash = readResult(resultPath(run.id))?.hash;
    notice.text = `Amendment ${number} (appended to ${packet}):\n${text.trim()}`;
    return changePacket(current, {
      assignment: { ...unaccepted(assignment), revision: number, status: 'active' },
      amendment: { number, ...(hash ? { resultHash: hash } : {}) }, notice,
      packet: `${readFileSync(packet, 'utf8')}\n## Amendment ${number} (${notice.at})\n\n${text.trim()}\n`,
    });
  }) ?? run;
  return { run: amended, number, delivery: deliver(runAddress(amended), notice) };
}

/** New outcome, same retained member/host/model. Old packets and result history remain inspectable. */
export function assign(from: Address, runRef: string, text: string): { run: RunMeta; delivery: Delivery } {
  const run = findRun(runRef);
  if (!run) throw new Error(`crew: no run matches "${runRef}"`);
  if (!text.trim()) throw new Error('crew: empty assignment');
  const notice: Mail = { id: newId('m'), at: new Date().toISOString(), kind: 'assignment', from, text: '' };
  const assigned = updateRun(run.id, current => {
    if (current.parent.mailbox !== from.mailbox) throw new Error(`crew: only ${current.name}'s parent can assign it work`);
    if (!current.keep || current.state === 'stopped') throw new Error('crew: assign requires a retained member that has not been stopped');
    const previous = currentAssignment(current);
    if (previous.status === 'active' || current.state === 'running' || activeDescendants(current.id).length || packetMail(current)) {
      throw new Error('crew: current work must settle before a new assignment; revise it with crew amend');
    }
    const submitted = previous.submissions.find(s => s.ref === previous.submission);
    if (!submitted || submitted.revision !== previous.revision || readResult(resultPath(current.id))?.hash !== submitted.hash
      || readResult(submitted.result)?.hash !== submitted.hash || packetHash(current.id) !== submitted.packetHash) {
      throw new Error('crew: current submission is stale; settle the changed result before assigning a new outcome');
    }
    const id = newId('task');
    const assignment = { id, revision: 0, createdAt: notice.at, status: 'active' as const, submissions: [] };
    const dir = join(runDir(current.id), 'assignments');
    mkdirSync(dir, { recursive: true });
    const oldPacket = readFileSync(packetPath(current.id), 'utf8');
    try { writeFileSync(join(dir, `${previous.id}.md`), oldPacket, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    notice.text = `Assignment ${id} (replaced current packet at ${packetPath(current.id)}):\n${text.trim()}`;
    return changePacket(current, { assignment, assignmentHistory: [...(current.assignmentHistory ?? []), previous], notice,
      packet: `${text.trim()}\n`, draft: '# Status\nIN PROGRESS: new assignment\n' });
  })!;
  return { run: assigned, delivery: deliver(runAddress(assigned), notice) };
}

const fromRun = (run: RunMeta): Mail['from'] => ({ mailbox: run.id, name: run.name, host: run.route.host });

/** First caller wins: the child's Stop hook and the parent's sweep race to report the same event. */
function claim(id: string, event: string): boolean {
  try { writeFileSync(join(runDir(id), `.${event}`), '', { flag: 'wx' }); return true; }
  catch { return false; }
}

const settlementEvent = (id: string, settled: NonNullable<RunMeta['settled']>): string =>
  join(runDir(id), `.settled-${settled.ref ?? settled.hash}`);

export function hasPendingSettlement(id: string): boolean {
  try {
    return readdirSync(runDir(id)).filter(name => name.startsWith('.settled-')).some(name => {
      try { const event = readJson<NonNullable<RunMeta['settled']>>(join(runDir(id), name)); return Boolean(event?.notice && !event.notified); }
      catch { return false; }
    });
  } catch { return false; }
}

/** Scan the durable outbox, including claims left before metadata or replaced by later results. */
function flushSettlement(id: string): Delivery | undefined {
  const run = readRun(id);
  if (!run) return undefined;
  let events: string[] = [];
  try { events = readdirSync(runDir(id)).filter(name => name.startsWith('.settled-')).map(name => join(runDir(id), name)); } catch { /* absent */ }
  const pending = new Map<string, NonNullable<RunMeta['settled']>>();
  for (const file of events) {
    try {
      const event = readJson<NonNullable<RunMeta['settled']>>(file);
      if (event?.notice && !event.notified) pending.set(event.notice.id, event);
    } catch { /* legacy empty claims */ }
  }
  if (run.settled?.notice && !run.settled.notified) pending.set(run.settled.notice.id, run.settled);
  let delivery: Delivery | undefined;
  for (const settled of pending.values()) {
    delivery = deliver(run.parent, settled.notice!);
    const acknowledged = { ...settled, notified: true };
    writeJson(settlementEvent(id, settled), acknowledged);
    updateRun(id, current => current.settled?.notice?.id === settled.notice!.id ? { ...current, settled: acknowledged } : undefined);
  }
  return delivery;
}

/** Tell the parent about a terminal submission, once per assignment/revision/content. */
export function settle(id: string, finishTurn = false): Delivery | undefined {
  const pendingDelivery = flushSettlement(id);
  const value = candidate(id);
  if (!value) return pendingDelivery;
  const { status } = value;
  let fresh: RunMeta | undefined;
  let isNew = false;
  updateRun(id, run => {
    if (run.state === 'stopped' || activeDescendants(id).length || candidate(id)?.text !== value.text) return undefined;
    let assignment = currentAssignment(run);
    if (assignment.status !== 'active' && assignment.submissions.find(s => s.ref === assignment.submission)?.hash !== status.hash) {
      assignment = { ...unaccepted(assignment), revision: assignment.revision + 1, status: 'active' };
    }
    const ref = `${assignment.id}-r${assignment.revision}-${status.hash}`;
    if (run.settled?.ref === ref) {
      if (finishTurn && !packetMail(run) && run.amendment?.resultHash !== status.hash) return { ...run, state: run.keep && status.verdict === 'done' ? 'idle' : status.verdict };
      return undefined;
    }
    if (candidate(id)?.text !== value.text || run.amendment?.resultHash === status.hash || packetMail(run)) return undefined;
    const submission = snapshot(id, assignment, value);
    let settled: NonNullable<RunMeta['settled']>;
    const event = join(runDir(id), `.settled-${ref}`);
    try {
      const at = submission.at;
      settled = { ref, hash: status.hash, at, status: status.line, notice: {
        id: `settled-${id}-${ref}`, at, kind: 'settled', from: fromRun(run),
        text: `${run.role} on ${run.route.model}@${run.route.effort}: ${status.line} (assignment ${assignment.id}, submission ${ref}; awaiting parent acceptance)`,
        result: submission.result,
      } };
      // The claim IS the outbox, replayed even if metadata is never committed.
      writeFileSync(event, JSON.stringify(settled), { flag: 'wx', mode: 0o600 });
      isNew = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { settled = readJson<NonNullable<RunMeta['settled']>>(event)!; } catch { return undefined; }
      if (!settled?.notice) return undefined;
    }
    const submitted = assignment.submissions.find(s => s.ref === ref) ?? { ...submission, at: settled.at };
    fresh = { ...run, state: run.keep && status.verdict === 'done' ? 'idle' : status.verdict, settled,
      assignment: { ...unaccepted(assignment), status: 'submitted', submission: ref,
        submissions: assignment.submissions.some(s => s.ref === ref) ? assignment.submissions : [...assignment.submissions, submitted] } };
    return fresh;
  });
  const delivery = flushSettlement(id) ?? pendingDelivery;
  if (isNew && fresh) { try { reviewed(fresh, status); } catch { /* routing evidence is best effort */ } }
  return delivery;
}

/** A new draft after submission invalidates acceptance and becomes active work, also for kept members. */
export function reopen(run: RunMeta): RunMeta {
  if (!run.settled || run.state === 'stopped' || (run.state === 'running' && run.assignment?.status === 'active')) return run;
  const line = progressLine(resultPath(run.id));
  if (!line) return run;
  const fresh = updateRun(run.id, current => {
    if (current.state !== run.state || current.settled?.hash !== run.settled?.hash || !progressLine(resultPath(run.id))) return undefined;
    const assignment = currentAssignment(current);
    return { ...current, state: 'running', assignment: { ...unaccepted(assignment), revision: assignment.revision + 1, status: 'active' } };
  }) ?? run;
  if (fresh.state === 'running' && claim(run.id, `reopened-${run.settled.ref ?? run.settled.hash}`)) {
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

/** A child waiting on native human input. Reported once per episode. */
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
    text: run.launcher === 'console'
      ? `is waiting on a native approval or question in the Crew console (run ${run.name}, ${run.id}); agent mail cannot answer a native human request`
      : run.bgId
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
  if (mail.kind === 'amendment' || mail.kind === 'assignment') return `[${mail.kind}] from ${who} (part of your packet):\n${mail.text}`;
  return `[${mail.kind}] ${who}: ${mail.text}${mail.result ? `\n  result: ${mail.result}` : ''}`;
}
