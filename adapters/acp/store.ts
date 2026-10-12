import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, readJson, withLock, writeJson } from '../../src/store.ts';
import type { ConsoleAccess, ConsoleEvent, ConsoleMode } from '../../src/console-types.ts';

export class AcpError extends Error {
  readonly code: number;
  constructor(message: string, code = -32602) { super(message); this.code = code; }
}
export interface AcpSession {
  id: string;
  cwd: string;
  modelId: string;
  mode: ConsoleMode;
  access: ConsoleAccess;
  effort?: string;
  mcpServers: unknown[];
  createdAt: string;
  updatedAt: string;
  title: string;
  consoleId?: string;
  launchRequestId?: string;
  closed?: boolean;
}
export interface SavedEvent { target: string; cursor?: string; event: ConsoleEvent; crew?: Record<string, unknown> }
const sessionId = (value: string): string => {
  if (!/^acp-[a-f0-9]{32}$/.test(value)) throw new AcpError('Invalid ACP session ID.');
  return value;
};
/** Session IDs and ownership are adapter-private, never application/provider IDs. */
export class AcpStore {
  readonly directory: string;
  private epoch = randomBytes(24).toString('hex');
  private owned = new Set<string>();
  constructor(root: string) {
    this.directory = join(root, 'adapters', 'acp');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  path(id: string, suffix = 'json') { return join(this.directory, `${sessionId(id)}.${suffix}`); }
  create(input: Omit<AcpSession, 'id' | 'createdAt' | 'updatedAt'>): AcpSession {
    const now = new Date().toISOString();
    const session = { ...input, id: `acp-${randomBytes(16).toString('hex')}`, createdAt: now, updatedAt: now };
    writeFileSync(this.path(session.id), JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    this.claim(session.id);
    return session;
  }
  read(id: string): AcpSession {
    const value = readJson<AcpSession>(this.path(id));
    if (!value || value.id !== id) throw new AcpError('ACP session not found.', -32002);
    return value;
  }
  save(session: AcpSession): void {
    this.assertOwned(session.id);
    session.updatedAt = new Date().toISOString();
    writeJson(this.path(session.id), session);
  }
  list(): AcpSession[] {
    return readdirSync(this.directory).filter(name => /^acp-[a-f0-9]{32}\.json$/.test(name))
      .flatMap(name => { try { return [this.read(name.slice(0, -5))]; } catch { return []; } })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  private locked<T>(id: string, work: () => T): T {
    return withLock(`acp-${createHash('sha256').update(this.directory + id).digest('hex')}`, work);
  }
  claim(id: string): void {
    if (this.owned.has(id)) return;
    this.read(id);
    this.locked(id, () => {
      const path = this.path(id, 'owner');
      const previous = readJson<{ pid: number; epoch: string }>(path);
      if (previous) {
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 1 || alive(previous.pid))
          throw new AcpError('ACP session is owned by another live connection.', -32003);
        unlinkSync(path);
      }
      try { writeFileSync(path, JSON.stringify({ pid: process.pid, epoch: this.epoch }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AcpError('ACP session ownership is unavailable.', -32003); throw error; }
      this.owned.add(id);
    });
  }
  assertOwned(id: string): void {
    const owner = readJson<{ epoch: string }>(this.path(id, 'owner'));
    if (!this.owned.has(id) || owner?.epoch !== this.epoch) throw new AcpError('Load this session on this connection first.', -32003);
  }
  release(id: string): void {
    if (!this.owned.has(id)) return;
    this.locked(id, () => {
      const path = this.path(id, 'owner');
      if (readJson<{ epoch: string }>(path)?.epoch === this.epoch) unlinkSync(path);
      this.owned.delete(id);
    });
  }
  append(id: string, item: SavedEvent): void {
    this.assertOwned(id);
    appendFileSync(this.path(id, 'events'), `${JSON.stringify(item)}\n`, { mode: 0o600 });
  }
  history(id: string, onCursor?: (target: string, cursor: string) => void): Map<string, SavedEvent> {
    const events = new Map<string, SavedEvent>();
    let data: string;
    try { data = readFileSync(this.path(id, 'events'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return events; throw error; }
    for (const line of data.split('\n')) {
      if (!line) continue;
      let item: SavedEvent;
      try { item = JSON.parse(line) as SavedEvent; } catch { continue; } // A crash may leave a partial last append.
      if (item.event?.id && typeof item.target === 'string') {
        events.set(`${item.target}/${item.event.id}`, item);
        if (typeof item.cursor === 'string') onCursor?.(item.target, item.cursor);
      }
    }
    return events;
  }
}
