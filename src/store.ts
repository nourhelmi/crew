import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, Mail, RunMeta } from './types.ts';

export const home = (): string => process.env.CREW_HOME || join(homedir(), '.crew');
export const configPath = (): string => process.env.CREW_CONFIG || join(homedir(), '.config', 'crew', 'config.json');

const DEFAULT_CONFIG: Config = {
  defaults: { advisor: 'claude-opus-5-5@high', builder: 'gpt-6-sol@high', checker: 'gpt-6-sol@xhigh' },
  router: { enabled: true, command: 'agent-router', timeoutMs: 90_000 },
  args: { claude: ['--permission-mode', 'auto'], codex: [] },
  trust: { roots: [] },
};

export function loadConfig(): Config {
  const user = readJson<Partial<Config>>(configPath()) ?? {};
  return {
    defaults: { ...DEFAULT_CONFIG.defaults, ...user.defaults },
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

export const readRun = (id: string): RunMeta | undefined => readJson<RunMeta>(join(runDir(id), 'meta.json'));
export const writeRun = (meta: RunMeta): void => writeJson(join(runDir(meta.id), 'meta.json'), meta);

export function updateRun(id: string, patch: (meta: RunMeta) => RunMeta | undefined): RunMeta | undefined {
  const meta = readRun(id);
  if (!meta) return undefined;
  const next = patch(meta);
  if (next) writeRun(next);
  return next ?? meta;
}

export function listRuns(): RunMeta[] {
  let ids: string[];
  try { ids = readdirSync(join(home(), 'runs')); }
  catch { return []; }
  return ids.map(readRun).filter((meta): meta is RunMeta => meta !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Resolve a run by id or by name; the newest live run wins a name clash. */
export function findRun(ref: string): RunMeta | undefined {
  const direct = readRun(ref);
  if (direct) return direct;
  const named = listRuns().filter(run => run.name === ref);
  return named.findLast(run => run.state === 'running') ?? named.at(-1);
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
  return { mails, commit: () => { if (complete) writeFileSync(cursorFile, String(start + complete)); } };
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
