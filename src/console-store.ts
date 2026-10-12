import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, readJson, withLock, writeJson } from './store.ts';
import type { HostIdentity } from './console-host.ts';
import { processExists } from './console-process.ts';
import type { ConsoleAction, ConsoleAnswer, ConsoleChange, ConsoleCommand, ConsoleDetail, ConsoleEvent, ConsoleFeed, ConsoleLaunch, ConsoleMessage, ConsoleRequest, ConsoleSession } from './console-types.ts';

export class ConsoleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
export const SAFE_CONSOLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const consoleDir = (root = home()): string => join(root, 'console');
export function sessionDir(id: string, root = home()): string {
  if (!SAFE_CONSOLE_ID.test(id)) throw new ConsoleError('Invalid session identity.');
  return join(consoleDir(root), 'sessions', id);
}
export interface ConsoleMeta {
  launch: ConsoleLaunch;
  instructions: string;
  /** A Crew run with a live owned pipe, not another console root. */
  child?: { runId: string; rootSessionId: string; router?: boolean };
  /** Bind policy without duplicating credential-bearing native CLI arguments. */
  argsHash?: string;
  /** Legacy private metadata, scrubbed when its supervisor next owns it. */
  args?: string[];
  identity?: HostIdentity;
  pid?: number;
  epoch?: string;
  heartbeat?: number;
  /** Explicit user interruption suppresses child-mail wakeups until human continuation. */
  mailPaused?: boolean;
  /** The owned provider was deliberately released successfully; recovery stays explicit. */
  suspended?: boolean;
  retiring?: boolean;
  wake?: { id: string; state: 'attempted' | 'accepted' | 'uncertain' };
}
export interface ConsoleView {
  session: ConsoleSession;
  events: ConsoleEvent[];
  requests: ConsoleRequest[];
  commands: Record<string, ConsoleCommand>;
  sequence: number;
}
export type ConsoleIntent = { kind: 'launch'; payload: ConsoleLaunch }
  | { kind: 'message'; payload: ConsoleMessage }
  | { kind: 'action'; payload: ConsoleAction }
  | { kind: 'answer'; payload: ConsoleAnswer };
export interface ConsoleReceipt {
  requestId: string;
  hash: string;
  intent: ConsoleIntent;
  /** written before host effects. A lost owner may never replay attempted input. */
  phase: 'pending' | 'attempted' | 'complete';
  command: ConsoleCommand;
  error?: { message: string; status: number; code: string };
  acceptedAt: string;
  owner?: string;
}
export const metaPath = (id: string, root = home()): string => join(sessionDir(id, root), 'meta.json');
export const viewPath = (id: string, root = home()): string => join(sessionDir(id, root), 'view.json');
export const receiptPath = (id: string, requestId: string, root = home()): string => {
  if (!SAFE_CONSOLE_ID.test(requestId)) throw new ConsoleError('Invalid request ID.');
  return join(sessionDir(id, root), 'commands', `${requestId}.json`);
};
export const readMeta = (id: string, root = home()): ConsoleMeta | undefined => readJson<ConsoleMeta>(metaPath(id, root));
export const readView = (id: string, root = home()): ConsoleView | undefined => readJson<ConsoleView>(viewPath(id, root));
export const readReceipt = (id: string, requestId: string, root = home()): ConsoleReceipt | undefined => readJson<ConsoleReceipt>(receiptPath(id, requestId, root));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const intentHash = (intent: ConsoleIntent): string => createHash('sha256').update(JSON.stringify(canonical(intent))).digest('hex');
export const consoleArgsHash = (args: string[]): string => createHash('sha256').update(JSON.stringify(args)).digest('hex');
export function acceptIntent(id: string, intent: ConsoleIntent, root = home()): ConsoleReceipt {
  const requestId = intent.payload.requestId;
  const path = receiptPath(id, requestId, root);
  const hash = intentHash(intent);
  const existing = readReceipt(id, requestId, root);
  if (existing) {
    if (existing.hash !== hash) throw new ConsoleError('This request ID already identifies different input.', 409, 'REQUEST_ID_CONFLICT');
    return existing;
  }
  mkdirSync(join(sessionDir(id, root), 'commands'), { recursive: true, mode: 0o700 });
  if (readdirSync(join(sessionDir(id, root), 'commands')).length >= 10_000) throw new ConsoleError('Session command limit reached. Start another session.', 409, 'SESSION_LIMIT');
  const receipt: ConsoleReceipt = { requestId, hash, intent, phase: 'pending', command: { requestId, state: 'queued' }, acceptedAt: new Date().toISOString() };
  try { writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const live = readReceipt(id, requestId, root);
    if (!live || live.hash !== hash) throw new ConsoleError('This request ID already identifies different input.', 409, 'REQUEST_ID_CONFLICT');
    return live;
  }
  return receipt;
}
export function receipts(id: string, root = home()): ConsoleReceipt[] {
  try { return readdirSync(join(sessionDir(id, root), 'commands')).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n)).flatMap(n => {
    const r = readJson<ConsoleReceipt>(join(sessionDir(id, root), 'commands', n)); return r ? [r] : [];
  }).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.requestId.localeCompare(b.requestId)); }
  catch { return []; }
}
export function supervisorAlive(meta: ConsoleMeta | undefined): boolean {
  if (!meta?.pid || !meta.epoch || !meta.heartbeat || Date.now() - meta.heartbeat > 10_000) return false;
  try { return processExists(meta.pid); } catch { return false; }
}
export function publicSession(id: string, root = home()): ConsoleSession | undefined {
  const stored = readJson<ConsoleSession>(join(sessionDir(id, root), 'session.json')) ?? readView(id, root)?.session;
  if (!stored) return;
  const session = { ...stored };
  const meta = readMeta(id, root);
  if (!['closed', 'failed', 'disconnected'].includes(session.state) && !supervisorAlive(meta)
    && (meta?.identity || Date.now() - Date.parse(session.createdAt) > 10_000)) {
    session.state = 'disconnected'; session.error = 'The owned supervisor is unavailable. Resume explicitly to recover the recorded session.';
  }
  return session;
}
export function consoleSessions(root = home()): ConsoleSession[] {
  try { return readdirSync(join(consoleDir(root), 'sessions')).filter(id => SAFE_CONSOLE_ID.test(id)).flatMap(id => {
    try { const s = readMeta(id, root)?.child ? undefined : publicSession(id, root); return s ? [s] : []; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  catch { return []; }
}
export function consoleDetail(id: string, before?: string, root = home()): ConsoleDetail | undefined {
  const view = readView(id, root); const session = publicSession(id, root);
  if (!view || !session) return;
  if (before !== undefined && !/^\d{1,16}$/.test(before)) throw new ConsoleError('Invalid history cursor.');
  const events = view.events.filter(e => before === undefined || e.sequence < Number(before)).slice(-100);
  const more = events.length && view.events.some(e => e.sequence < events[0]!.sequence);
  return { session, events, commands: Object.values(view.commands).slice(-100), requests: session.state === 'disconnected' || session.state === 'closed' ? [] : view.requests,
    ...(more ? { before: String(events[0]!.sequence) } : {}) };
}
export function consoleRequests(id: string, root = home()): ConsoleRequest[] {
  const session = publicSession(id, root);
  if (!session || ['disconnected', 'closed'].includes(session.state)) return [];
  return readJson<ConsoleRequest[]>(join(sessionDir(id, root), 'requests.json')) ?? readView(id, root)?.requests ?? [];
}
export function writeView(id: string, view: ConsoleView, root = home()): void {
  // Keep complete public event objects, with a bounded retention window and bounded text.
  let bytes = 0;
  view.events = view.events.slice(-2_500).reverse().filter(e => { bytes += JSON.stringify(e).length; return bytes <= 4 * 1024 * 1024; }).reverse();
  writeJson(viewPath(id, root), { ...view, events: view.events.map(event => ({ ...event, text: event.text.slice(0, 24_000) })) });
  // Liveness checks need only session metadata, never the retained transcript.
  writeJson(join(sessionDir(id, root), 'session.json'), view.session);
  writeJson(join(sessionDir(id, root), 'requests.json'), view.requests);
}

const journalPath = (id: string, root: string): string => join(sessionDir(id, root), 'events.jsonl');
/** The single supervisor appends before publishing its bounded view. Legacy views seed a
 * journal once, explicitly reporting that earlier output may already have been trimmed. */
export function ensureConsoleJournal(id: string, root = home()): void {
  const path = journalPath(id, root);
  if (existsSync(path)) return;
  withLock(`console-journal-${createHash('sha256').update(root + id).digest('hex')}`, () => {
    if (existsSync(path)) return;
    const view = readView(id, root);
    if (!view) throw new ConsoleError('Managed session is unavailable.', 404, 'SESSION_NOT_FOUND');
    const initial: ConsoleChange[] = [{ kind: 'session', session: view.session }, { kind: 'requests', requests: view.requests },
      ...view.events.map(event => ({ kind: 'event' as const, event })), ...Object.values(view.commands).map(command => ({ kind: 'command' as const, command }))];
    writeFileSync(path, [JSON.stringify({ version: 1, epoch: randomBytes(16).toString('hex'), legacy: view.sequence > 0 }),
      ...initial.map(change => JSON.stringify(change))].join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  });
}
export function appendConsoleChanges(id: string, changes: ConsoleChange[], root = home()): void {
  if (!changes.length) return;
  ensureConsoleJournal(id, root);
  const path = journalPath(id, root); const fd = openSync(path, 'r');
  let interrupted = false;
  try {
    let offset = fstatSync(fd).size; const last = Buffer.alloc(1);
    if (offset && readSync(fd, last, 0, 1, offset - 1) && last[0] !== 10) {
      // A former owner may have died inside a write. Retain every complete record,
      // discard only the incomplete suffix and put the loss in the feed itself.
      interrupted = true;
      while (offset) {
        const start = Math.max(0, offset - 64 * 1024); const chunk = Buffer.alloc(offset - start);
        readSync(fd, chunk, 0, chunk.length, start); const end = chunk.lastIndexOf(10);
        if (end >= 0) { truncateSync(path, start + end + 1); break; }
        offset = start;
      }
      if (!offset) throw new ConsoleError('Event journal header is incomplete.', 503, 'STATE_UNAVAILABLE');
    }
  } finally { closeSync(fd); }
  appendFileSync(path, (interrupted ? '{"kind":"gap","reason":"interrupted-write"}\n' : '') + changes.map(change => JSON.stringify(change)).join('\n') + '\n', { mode: 0o600 });
}

/** Read only bytes after the cursor. Each record is an upsert, including streaming text
 * updates. Incomplete last writes are retried, never silently skipped. */
export function consoleEvents(id: string, cursor?: string, limit = 100, root = home()): ConsoleFeed {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ConsoleError('Event limit must be between 1 and 1000.');
  ensureConsoleJournal(id, root);
  const fd = openSync(journalPath(id, root), 'r');
  try {
    const size = fstatSync(fd).size;
    const headerBytes = Buffer.alloc(Math.min(size, 256)); readSync(fd, headerBytes, 0, headerBytes.length, 0);
    const headerEnd = headerBytes.indexOf(10) + 1;
    if (!headerEnd) throw new ConsoleError('Event journal header is incomplete.', 503, 'STATE_UNAVAILABLE');
    const header = JSON.parse(headerBytes.subarray(0, headerEnd).toString()) as { version: number; epoch: string; legacy: boolean };
    if (header.version !== 1 || !/^[a-f0-9]{32}$/.test(header.epoch)) throw new ConsoleError('Event journal version is unsupported.', 409, 'STATE_UNAVAILABLE');
    let offset = headerEnd;
    let gap: ConsoleFeed['gap'] = !cursor && header.legacy ? { reason: 'legacy' } : undefined;
    if (cursor !== undefined) {
      const match = /^([a-f0-9]{32}):(\d{1,16})$/.exec(cursor);
      if (!match) gap = { reason: 'invalid' };
      else if (match[1] !== header.epoch) gap = { reason: 'expired' };
      else {
        const at = Number(match[2]); const last = Buffer.alloc(1);
        if (!Number.isSafeInteger(at) || at < headerEnd || at > size || readSync(fd, last, 0, 1, at - 1) !== 1 || last[0] !== 10) gap = { reason: 'invalid' };
        else offset = at;
      }
    }
    const changes: ConsoleFeed['changes'] = [];
    let readAt = offset; let pending = Buffer.alloc(0);
    while (readAt < size && changes.length < limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - readAt));
      const count = readSync(fd, chunk, 0, chunk.length, readAt);
      if (!count) break;
      readAt += count; pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let end: number;
      while (changes.length < limit && (end = pending.indexOf(10)) !== -1) {
        const change = JSON.parse(pending.subarray(0, end).toString('utf8')) as ConsoleChange | { kind: 'gap'; reason: 'interrupted-write' };
        offset += end + 1; pending = pending.subarray(end + 1);
        if (change.kind === 'gap') gap = { reason: change.reason };
        else changes.push({ ...change, cursor: `${header.epoch}:${offset}` });
      }
    }
    return { cursor: `${header.epoch}:${offset}`, changes, more: offset < size, ...(gap ? { gap } : {}) };
  } finally { closeSync(fd); }
}
export function directoryExists(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}
