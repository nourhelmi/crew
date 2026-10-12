import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRoster, rosterDefaults } from './roster.ts';
import type { Assignment, Config, Mail, RunMeta } from './types.ts';

export const home = (): string => process.env.CREW_HOME || join(homedir(), '.crew');
export const configPath = (): string => process.env.CREW_CONFIG || join(homedir(), '.config', 'crew', 'config.json');

const DEFAULT_CONFIG: Config = {
  defaults: { advisor: 'claude-opus-5-5@high', builder: 'gpt-6.1-sol@high', checker: 'gpt-6.1-sol@xhigh' },
  router: { enabled: true, command: 'agent-router', timeoutMs: 90_000 },
  args: { claude: ['--permission-mode', 'auto'], codex: [], opencode: [] },
  trust: { roots: [] },
};

export function loadConfig(): Config {
  const user = readJson<Partial<Config>>(configPath()) ?? {};
  // Explicit defaults win, then your roster's first launchable model per role. A broken roster
  // must not break hooks; `crew roster` reports it.
  let fromRoster = {};
  try { fromRoster = rosterDefaults(loadRoster()); } catch { /* reported by crew roster */ }
  return {
    defaults: { ...DEFAULT_CONFIG.defaults, ...fromRoster, ...user.defaults },
    router: { ...DEFAULT_CONFIG.router, ...user.router },
    args: { ...DEFAULT_CONFIG.args, ...user.args },
    trust: { roots: (user.trust?.roots ?? DEFAULT_CONFIG.trust.roots).map(root => root.replace(/^~(?=\/|$)/, homedir())) },
  };
}

export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36).slice(-5)}${randomBytes(2).toString('hex')}`;

// ---- runs ------------------------------------------------------------------

export const runDir = (id: string): string => join(home(), 'runs', id);
export const resultPath = (id: string): string => join(runDir(id), 'result.md');
export const packetPath = (id: string): string => join(runDir(id), 'packet.md');
/** The child's standing instructions from crew (bootstrap), kept apart from the parent's packet. */
export const briefPath = (id: string): string => join(runDir(id), 'brief.md');

export const readRun = (id: string): RunMeta | undefined => readJson<RunMeta>(join(runDir(id), 'meta.json'));
export const writeRun = (meta: RunMeta): void => writeJson(join(runDir(meta.id), 'meta.json'), meta);

/** Packet changes span metadata, packet and inbox. One intent under the existing run mutex
 * recovers a crashed assign/amend before another metadata mutation can observe completion. */
export interface PacketChange {
  assignment: Assignment;
  assignmentHistory?: Assignment[];
  amendment?: NonNullable<RunMeta['amendment']>;
  packet: string;
  notice: Mail;
  draft?: string;
  nativeAmendment?: { requestId: string; hash: string; number: number };
}
const packetChangePath = (id: string): string => join(runDir(id), 'packet-change.json');
export const nativeAmendmentPath = (id: string, requestId: string): string =>
  join(runDir(id), 't3-amendments', `${createHash('sha256').update(requestId).digest('hex')}.json`);

function applyPacketChange(meta: RunMeta, change: PacketChange): RunMeta {
  writeFileSync(packetPath(meta.id), change.packet, { mode: 0o600 });
  if (change.draft !== undefined) writeFileSync(resultPath(meta.id), change.draft, { mode: 0o600 });
  let delivered = false;
  try { delivered = readFileSync(join(mailDir(meta.id), 'inbox.jsonl'), 'utf8').split('\n').some(line => {
    try { return JSON.parse(line).id === change.notice.id; } catch { return false; }
  }); } catch { /* first mail */ }
  if (!delivered) appendMail(meta.id, change.notice);
  if (change.nativeAmendment) writeJson(nativeAmendmentPath(meta.id, change.nativeAmendment.requestId), change.nativeAmendment);
  const { amendment: _, ...rest } = meta;
  return { ...rest, state: 'running', assignment: change.assignment,
    // The native composer owns dispatch of this message, so watchers must not launch a second turn.
    ...(change.nativeAmendment ? { resumedMail: change.notice.id } : {}),
    ...(change.assignmentHistory ? { assignmentHistory: change.assignmentHistory } : {}),
    ...(change.amendment ? { amendment: change.amendment } : {}) };
}

/** Call only within updateRun's patch; updateRun removes the intent after the metadata commit. */
export function changePacket(meta: RunMeta, change: PacketChange): RunMeta {
  writeJson(packetChangePath(meta.id), change);
  return applyPacketChange(meta, change);
}

export function updateRun(id: string, patch: (meta: RunMeta) => RunMeta | undefined): RunMeta | undefined {
  return withLock(`run-${id}`, () => {
    let meta = readRun(id);
    if (!meta) return undefined;
    const intent = readJson<PacketChange>(packetChangePath(id));
    if (intent) {
      meta = applyPacketChange(meta, intent);
      writeRun(meta);
      unlinkSync(packetChangePath(id));
    }
    const next = patch(meta);
    if (next) {
      writeRun(next);
      try { unlinkSync(packetChangePath(id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return next ?? meta;
  });
}

export function listRuns(): RunMeta[] {
  let ids: string[];
  try { ids = readdirSync(join(home(), 'runs')); }
  catch { return []; }
  return ids.map(readRun).filter((meta): meta is RunMeta => meta !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Retained identities reserve their names until explicitly retired. */
export const retained = (run: RunMeta): boolean => run.state !== 'stopped' && (run.keep || run.state === 'running');

/** Resolve a run by id or by name; the newest live run wins a name clash. */
export function findRun(ref: string): RunMeta | undefined {
  const direct = readRun(ref);
  if (direct) return direct;
  const named = listRuns().filter(run => run.name === ref);
  return named.findLast(retained) ?? named.at(-1);
}

// ---- mail ------------------------------------------------------------------

const safe = (mailbox: string): string => mailbox.replace(/[^a-zA-Z0-9._-]/g, '_');
export const mailDir = (mailbox: string): string => join(home(), 'mail', safe(mailbox));

export function appendMail(mailbox: string, mail: Mail): void {
  const dir = mailDir(mailbox);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify(mail)}\n`, { mode: 0o600 });
}

/** Unread mail past the cursor. Call `commit` once the reader has actually surfaced it. */
export function unread(mailbox: string): { mails: Mail[]; commit: () => void } {
  const dir = mailDir(mailbox);
  const cursorFile = join(dir, 'cursor');
  let start = 0;
  try { start = Number(readFileSync(cursorFile, 'utf8')) || 0; } catch { /* first read */ }
  let raw: Buffer;
  try { raw = readFileSync(join(dir, 'inbox.jsonl')); }
  catch { return { mails: [], commit: () => {} }; }
  if (start > raw.length) start = 0;
  const chunk = raw.subarray(start);
  const complete = chunk.lastIndexOf(0x0a) + 1; // ignore a line still being written
  const mails = chunk.subarray(0, complete).toString('utf8').split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line) as Mail]; } catch { return []; } });
  return { mails, commit: () => {
    if (!complete) return;
    withLock(`cursor-${mailbox}`, () => {
      let current = 0;
      try { current = Number(readFileSync(cursorFile, 'utf8')) || 0; } catch { /* first read */ }
      if (current > statSync(join(dir, 'inbox.jsonl')).size) current = 0; // inbox was truncated/replaced
      writeFileSync(cursorFile, String(Math.max(current, start + complete)));
    });
  } };
}

// ---- locks -----------------------------------------------------------------

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Cross-process mutex (mkdir is atomic). A holder older than `staleMs` is presumed dead. */
export function withLock<T>(name: string, work: () => T, waitMs = 30_000, staleMs = 60_000): T {
  const dir = join(home(), 'locks', name.replace(/[^a-zA-Z0-9._-]/g, '_'));
  mkdirSync(dirname(dir), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (mtime(dir) ?? Date.now());
      if (age > staleMs) { try { rmdirSync(dir); } catch { /* raced with another breaker */ } continue; }
      if (Date.now() > deadline) throw new Error(`crew: timed out waiting for lock ${name}`);
      pause(100);
    }
  }
  try { return work(); }
  finally { try { rmdirSync(dir); } catch { /* already broken as stale */ } }
}

/** A launch must keep its mutex through Node's asynchronous spawn/error event. */
export async function withLockAsync<T>(name: string, work: () => Promise<T>, waitMs = 90_000, staleMs = 120_000): Promise<T> {
  const dir = join(home(), 'locks', name.replace(/[^a-zA-Z0-9._-]/g, '_'));
  mkdirSync(dirname(dir), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - (mtime(dir) ?? Date.now()) > staleMs) { try { rmdirSync(dir); } catch { /* another breaker */ } continue; }
      if (Date.now() > deadline) throw new Error(`crew: timed out waiting for lock ${name}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await work(); }
  finally { try { rmdirSync(dir); } catch { /* already removed */ } }
}

// ---- waiter presence -------------------------------------------------------

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const waiterFile = (mailbox: string): string => join(mailDir(mailbox), 'waiter.pid');

export function markWaiter(mailbox: string): () => void {
  mkdirSync(mailDir(mailbox), { recursive: true });
  writeFileSync(waiterFile(mailbox), String(process.pid));
  return () => { try { if (readFileSync(waiterFile(mailbox), 'utf8') === String(process.pid)) writeFileSync(waiterFile(mailbox), ''); } catch { /* gone */ } };
}

export function hasWaiter(mailbox: string): boolean {
  try { return alive(Number(readFileSync(waiterFile(mailbox), 'utf8'))); }
  catch { return false; }
}

export function mtime(path: string): number | undefined {
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}
