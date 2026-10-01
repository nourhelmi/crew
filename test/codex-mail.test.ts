import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const HOME = mkdtempSync(join(tmpdir(), 'crew-codex-mail-'));
Object.assign(process.env, { CREW_HOME: HOME, CREW_CONFIG: join(HOME, 'config'), CREW_ROSTER: join(HOME, 'roster'), CODEX_HOME: join(HOME, 'codex'), CLAUDE_CONFIG_DIR: join(HOME, 'claude') });
delete process.env.CREW_CODEX_SOCKET; delete process.env.CODEX_APP_SERVER_WS_URL; delete process.env.CREW_RUN;
const { send, takeUnread } = await import('../src/mail.ts');
const { unread, mailDir, writeJson, markWaiter } = await import('../src/store.ts');
const { registerCodex, codexSocket } = await import('../src/codex-mail.ts');
const { self, owningCodexSocket } = await import('../src/identity.ts');
const to = { mailbox: 'codex-root', host: 'codex' as const, threadId: 'root', codexSocket: join(HOME, 'server.sock') };
const from = { mailbox: 'claude-child', host: 'claude' as const };
const scenarioFile = join(HOME, 'scenario.json'), eventsFile = join(HOME, 'events.jsonl');
let server: ChildProcess;
const scenario = (changes: object = {}) => writeJson(scenarioFile, { threadId: 'root', mailDir: mailDir(to.mailbox), ...changes });
const events = (): { method: string; params: Record<string, unknown> }[] => {
  try { return readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
};
const turns = () => events().filter(event => event.method.startsWith('turn/'));
beforeEach(() => { rmSync(join(HOME, 'mail'), { recursive: true, force: true }); writeFileSync(eventsFile, ''); scenario(); });
after(() => { server?.kill(); rmSync(HOME, { recursive: true, force: true }); });
await new Promise<void>((resolveReady, reject) => {
  server = spawn(process.execPath, [resolve('test/fixtures/codex-server.ts'), to.codexSocket, scenarioFile, eventsFile], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; server.stderr!.on('data', chunk => { errors += String(chunk); });
  server.once('exit', () => reject(new Error(errors || 'fixture server exited')));
  server.stdout!.once('data', () => resolveReady());
});

describe('Codex owning-server mail', () => {
  it('steers the current active turn once; consumes, then wakes a new batch', () => {
    assert.equal(send(from, to, 'first'), 'codex-steer');
    assert.equal(send(from, to, 'second'), 'queued');
    assert.equal(turns().length, 1);
    assert.equal(turns()[0]!.method, 'turn/steer');
    assert.equal(turns()[0]!.params.expectedTurnId, 'turn-current');
    assert.equal(JSON.stringify(turns()).includes('first'), false); // mail content stays in the inbox
    assert.deepEqual(takeUnread(to.mailbox).map(mail => mail.text), ['first', 'second']);
    assert.equal(send(from, to, 'third'), 'codex-steer');
    assert.equal(turns().length, 2);
  });
  it('starts an idle loaded root immediately without launch overrides', () => {
    scenario({ status: 'idle' });
    assert.equal(send(from, to, 'idle mail'), 'codex-start');
    assert.equal(turns()[0]!.method, 'turn/start');
    assert.deepEqual(Object.keys(turns()[0]!.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  });
  it('does not wake consumed mail after ownership queries', () => {
    scenario({ consume: true });
    assert.equal(send(from, to, 'already read'), 'queued');
    assert.equal(unread(to.mailbox).mails.length, 0);
    assert.equal(turns().length, 0);
  });
  it('leaves unloaded, foreign, busy, and non-direct roots in the inbox', () => {
    for (const changes of [{ unloaded: true }, { wrongId: true }, { direct: false }, { status: 'systemError' }, { turnStatus: 'completed' }]) {
      scenario(changes);
      assert.equal(send(from, to, 'retain'), 'queued');
    }
    assert.equal(unread(to.mailbox).mails.length, 5);
    assert.equal(turns().length, 0);
    assert.equal(events().some(event => /resume|queue/.test(event.method)), false);
  });
  it('never downgrades a rejected steer to a new turn; new mail can retry', () => {
    scenario({ reject: true });
    assert.equal(send(from, to, 'reject'), 'queued');
    assert.equal(existsSync(join(mailDir(to.mailbox), 'wake.json')), false);
    scenario(); assert.equal(send(from, to, 'next advice'), 'codex-steer');
    assert.deepEqual(turns().map(event => event.method), ['turn/steer', 'turn/steer']);
  });
  it('does not replay an ambiguously accepted wake, even after ten minutes', () => {
    scenario({ disconnect: true });
    assert.equal(send(from, to, 'uncertain'), 'queued');
    const path = join(mailDir(to.mailbox), 'wake.json');
    const wake = JSON.parse(readFileSync(path, 'utf8'));
    writeJson(path, { ...wake, at: Date.now() - 60 * 60_000 });
    scenario(); assert.equal(send(from, to, 'more advice'), 'queued');
    assert.equal(turns().length, 1);
    assert.equal(unread(to.mailbox).mails.length, 2);
    takeUnread(to.mailbox);
    assert.equal(send(from, to, 'fresh batch'), 'codex-steer');
    assert.equal(turns().length, 2);
  });
  it('bounds RPC timeouts and retains the attempted batch', () => {
    scenario({ timeout: true });
    const started = Date.now(); assert.equal(send(from, to, 'timeout'), 'queued');
    assert.ok(Date.now() - started < 6000);
    assert.equal(send(from, to, 'covered'), 'queued');
    assert.equal(turns().length, 1);
  });
  it('prefers foreground wait and follows loaded-list pagination', () => {
    const release = markWaiter(to.mailbox);
    assert.equal(send(from, to, 'wait'), 'waiter'); release(); takeUnread(to.mailbox);
    assert.equal(events().length, 0);
    scenario({ paginated: true }); assert.equal(send(from, to, 'page two'), 'codex-steer');
    assert.equal(events().filter(event => event.method === 'thread/loaded/list').length, 2);
  });
  it('registers only the loaded owning root and resolves its durable endpoint', async () => {
    await registerCodex(to, to.codexSocket);
    assert.equal(self({ CODEX_THREAD_ID: 'root' }).codexSocket, to.codexSocket);
    assert.equal(codexSocket(to.mailbox, { CODEX_APP_SERVER_WS_URL: 'ws+unix://localhost' + to.codexSocket + ':/rpc' }), to.codexSocket);
    scenario({ unloaded: true }); await assert.rejects(registerCodex(to, to.codexSocket), /not loaded/);
    await assert.rejects(registerCodex({ ...to, host: 'claude' }, to.codexSocket), /Codex root/);
  });
  it('uses the recipient registration over a stale recorded parent endpoint', async () => {
    await registerCodex(to, to.codexSocket);
    assert.equal(send(from, { ...to, codexSocket: join(HOME, 'old-server.sock') }, 'new owner'), 'codex-steer');
    assert.equal(unread(to.mailbox).mails[0]?.text, 'new owner');
  });
  it('discovers only an explicit Unix listener in its own Codex ancestry', () => {
    const process = { pid: 10, ppid: 1, comm: '/app/codex' };
    assert.equal(owningCodexSocket([process], () => '/app/codex -c features.x=true app-server --listen unix:///tmp/owner.sock -c x=y'), '/tmp/owner.sock');
    assert.equal(owningCodexSocket([process], () => '/app/codex app-server --listen stdio://'), undefined);
    assert.equal(owningCodexSocket([process], () => '/app/codex app-server --listen ws://127.0.0.1:123'), undefined);
    assert.equal(owningCodexSocket([{ ...process, comm: '/app/other' }], () => '/app/codex app-server --listen unix:///tmp/foreign.sock'), undefined);
    assert.equal(owningCodexSocket([process], () => { throw new Error('no visibility'); }), undefined);
  });
  it('serializes concurrent sends through the public CLI', async () => {
    writeJson(join(mailDir(to.mailbox), 'codex-connection.json'), { socket: to.codexSocket });
    const env = { ...process.env, CODEX_THREAD_ID: 'sender', CREW_NO_DELEGATE: '1', CREW_NODE: process.execPath };
    await Promise.all(['one', 'two'].map(text => exec(resolve('bin/crew'), ['msg', to.mailbox, text], { env })));
    assert.equal(turns().length, 1);
    assert.equal(unread(to.mailbox).mails.length, 2);
  });
});
