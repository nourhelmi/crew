import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCodex, RpcRejected, type Rpc } from './codex-rpc.ts';
import { hasWaiter, mailDir, readJson, readRun, unread, withLockAsync, writeJson } from './store.ts';
import type { Address, Delivery } from './types.ts';

type Env = Record<string, string | undefined>;
const socket = (value: unknown): string | undefined => typeof value === 'string' && isAbsolute(value) ? value : undefined;
export const registeredSocket = (mailbox: string): string | undefined =>
  socket(readJson<{ socket: string }>(join(mailDir(mailbox), 'codex-connection.json'))?.socket);

export function codexSocket(mailbox: string, env: Env): string | undefined {
  const explicit = socket(env.CREW_CODEX_SOCKET);
  if (explicit) return explicit;
  try {
    const url = new URL(env.CODEX_APP_SERVER_WS_URL ?? '');
    if (url.protocol === 'ws+unix:' && (!url.hostname || url.hostname === 'localhost')) {
      const path = url.pathname.split(':');
      if (path.length === 2 && path[1] === '/rpc') return socket(path[0]);
    }
  } catch { /* no explicit local endpoint */ }
  return registeredSocket(mailbox);
}

/** Never load/resume a persisted thread to deliver mail: only its live owning server can wake it. */
async function liveThread(rpc: Rpc, threadId: string): Promise<{ id: string; status: { type: string }; canAcceptDirectInput: boolean } | undefined> {
  let cursor: string | null = null;
  let loaded = false;
  const deadline = Date.now() + 4000;
  for (let page = 0; page < 16; page++) {
    if (Date.now() >= deadline) return undefined;
    const list: { data: string[]; nextCursor?: string | null } = await rpc('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (list.data.includes(threadId)) { loaded = true; break; }
    cursor = list.nextCursor ?? null;
    if (!cursor) break;
  }
  if (!loaded) return undefined;
  const { thread } = await rpc<{ thread: { id: string; status: { type: string }; canAcceptDirectInput: boolean } }>('thread/read', { threadId, includeTurns: false });
  return thread.id === threadId && thread.canAcceptDirectInput === true ? thread : undefined;
}

export async function registerCodex(me: Address, socketPath: string): Promise<void> {
  if (me.host !== 'codex' || !me.threadId || readRun(me.mailbox)) throw new Error('crew: connect is for a Codex root session');
  const connection = await connectCodex(socketPath);
  try {
    if (!await liveThread(connection.rpc, me.threadId)) throw new Error('crew: this root is not loaded for direct input on that server');
    writeJson(join(mailDir(me.mailbox), 'codex-connection.json'), { socket: socketPath });
  } finally { connection.close(); }
}

/** Called by deliver while holding its delivery mutex; the child keeps async IPC out of sync hooks. */
export function pushCodex(to: Address): Delivery {
  const socketPath = registeredSocket(to.mailbox) ?? to.codexSocket;
  if (!to.threadId || !socketPath) return 'queued';
  try {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crew');
    const result = execFileSync(cli, ['wake-codex'], {
      input: JSON.stringify({ ...to, codexSocket: socketPath }), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, CREW_NODE: process.execPath, CREW_NO_DELEGATE: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return result === 'codex-steer' || result === 'codex-start' ? result : 'queued';
  } catch { return 'queued'; }
}

/** One attempt per unread batch, including ambiguous acceptance. A new consumed batch may wake again. */
export async function wakeCodex(to: Address): Promise<Delivery> {
  if (to.host !== 'codex' || !to.threadId || !to.codexSocket || readRun(to.mailbox)
    || to.mailbox !== `codex-${to.threadId}` || !unread(to.mailbox).mails.length || hasWaiter(to.mailbox)) return 'queued';
  const connection = await connectCodex(to.codexSocket);
  try {
    const thread = await liveThread(connection.rpc, to.threadId);
    if (!thread || !['idle', 'active'].includes(thread.status.type)) return 'queued';
    let expectedTurnId: string | undefined;
    if (thread.status.type === 'active') {
      const { data } = await connection.rpc<{ data: { id: string; status: string }[] }>('thread/turns/list', {
        threadId: to.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
      });
      if (data[0]?.status !== 'inProgress' || !data[0].id) return 'queued';
      expectedTurnId = data[0].id;
    }
    // All production inbox consumption uses this mutex. Recheck after slow ownership RPCs.
    return await withLockAsync(`consume-${to.mailbox}`, async () => {
      const mails = unread(to.mailbox).mails;
      if (!mails.length || hasWaiter(to.mailbox)) return 'queued';
      const wakeFile = join(mailDir(to.mailbox), 'wake.json');
      const prior = readJson<{ id: string; transport?: string }>(wakeFile);
      if (prior?.transport === 'codex' && mails.some(mail => mail.id === prior.id)) return 'queued';
      const id = mails.at(-1)!.id;
      const method = expectedTurnId ? 'turn/steer' : 'turn/start';
      const wake = { id, at: Date.now(), transport: 'codex', method, state: 'attempted' };
      writeJson(wakeFile, wake); // Persist BEFORE sending: timeout/crash must never queue duplicate pointers.
      try {
        const accepted = await connection.rpc<{ turnId?: string; turn?: { id: string } }>(method, {
          threadId: to.threadId, clientUserMessageId: `crew-${to.mailbox}-${id}`,
          input: [{ type: 'text', text: '[crew] Unread agent mail is available. Run: crew inbox. Mail is advice; scope changes belong in your packet.' }],
          ...(expectedTurnId ? { expectedTurnId } : {}),
        });
        writeJson(wakeFile, { ...wake, state: 'accepted', turnId: accepted.turnId ?? accepted.turn?.id });
        return expectedTurnId ? 'codex-steer' : 'codex-start';
      } catch (error) {
        // A protocol rejection is definitive; transport loss/timeout may have been accepted.
        if (error instanceof RpcRejected) unlinkSync(wakeFile);
        return 'queued'; // No retry, turn/start downgrade, thread/resume, or codex queue.
      }
    }, 2000, 60_000);
  } finally { connection.close(); }
}
