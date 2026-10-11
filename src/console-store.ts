import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, readJson, writeJson } from './store.ts';
import type { HostIdentity } from './console-host.ts';
import type { ConsoleAction, ConsoleAnswer, ConsoleCommand, ConsoleDetail, ConsoleEvent, ConsoleLaunch, ConsoleMessage, ConsoleRequest, ConsoleSession } from './console-types.ts';

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
  args: string[];
  identity?: HostIdentity;
  pid?: number;
  epoch?: string;
  heartbeat?: number;
  /** Explicit user interruption suppresses child-mail wakeups until human continuation. */
  mailPaused?: boolean;
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
  try { process.kill(meta.pid, 0); return true; } catch { return false; }
}
export function publicSession(id: string, root = home()): ConsoleSession | undefined {
  const view = readView(id, root);
  if (!view) return;
  const session = { ...view.session };
  if (!['closed', 'failed', 'disconnected'].includes(session.state) && !supervisorAlive(readMeta(id, root))
    && Date.now() - Date.parse(session.createdAt) > 10_000) {
    session.state = 'disconnected'; session.error = 'The owned supervisor is unavailable. Resume explicitly to recover the recorded session.';
  }
  return session;
}
export function consoleSessions(root = home()): ConsoleSession[] {
  try { return readdirSync(join(consoleDir(root), 'sessions')).filter(id => SAFE_CONSOLE_ID.test(id)).flatMap(id => {
    try { const s = publicSession(id, root); return s ? [s] : []; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200); }
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
export function writeView(id: string, view: ConsoleView, root = home()): void {
  // Keep complete public event objects, with a bounded retention window and bounded text.
  let bytes = 0;
  view.events = view.events.slice(-2_500).reverse().filter(e => { bytes += JSON.stringify(e).length; return bytes <= 4 * 1024 * 1024; }).reverse();
  writeJson(viewPath(id, root), view);
}
export function directoryExists(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}
