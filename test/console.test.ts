import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ConsoleController, hostCapabilities } from '../src/console-controller.ts';
import { DashboardObserver } from '../src/dashboard-observe.ts';
import { createDashboardServer } from '../src/dashboard.ts';
import { acceptIntent, ConsoleError, consoleDetail, metaPath, readMeta, readReceipt, readView, receiptPath, sessionDir, viewPath } from '../src/console-store.ts';
import { appendMail, writeJson } from '../src/store.ts';
import type { ConsoleDetail, ConsoleLaunch, ConsoleMutation } from '../src/console-types.ts';
import type { RunMeta } from '../src/types.ts';

async function waitFor<T>(work: () => T | undefined | false, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = work(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Fixture condition timed out');
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-console-'));
  const prior = { ...process.env };
  for (const [name, value] of Object.entries({ HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ADVISOR_STATE_DIR: join(root, 'advisor') })) process.env[name] = value;
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: [], claude: [] } });
  writeJson(process.env.CREW_ROSTER!, { models: [{ model: 'codex/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }] });
  mkdirSync(join(root, 'bin'));
  for (const host of ['codex', 'claude', 'herdr']) { const path = join(root, 'bin', host); writeFileSync(path, '#!/bin/sh\nexit 99\n'); chmodSync(path, 0o755); }
  process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;
  const children: ChildProcess[] = [];
  let starts = 0;
  const controller = new ConsoleController({ root, providers: () => (['codex', 'claude'] as const).map(id => ({ id, label: id, available: true, models: [{ id: 'fixture', label: 'Fixture', efforts: ['high'] }], capabilities: hostCapabilities(id) })), receiptWaitMs: 2500,
    startSupervisor: async id => {
      starts++;
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./fixtures/console-supervisor.ts', import.meta.url).pathname, sessionDir(id, root)], { env: { ...process.env }, stdio: 'ignore' }); children.push(child);
      await once(child, 'spawn');
    } });
  const observer = new DashboardObserver({ crew: root, codex: join(root, 'codex'), claude: join(root, 'claude') });
  const servers: ReturnType<typeof createDashboardServer>[] = [];
  async function server() {
    const app = createDashboardServer(observer, 20, controller); servers.push(app);
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    const address = app.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'X-Crew-Token': controller.token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { app, origin, post };
  }
  const calls = (id: string): Record<string, unknown>[] => readFileSync(join(sessionDir(id, root), 'fixture-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const launch = (prompt = 'first', requestId = 'launch1', host: 'codex' | 'claude' = 'codex'): ConsoleLaunch => ({ requestId, cwd: root, mode: 'advisor', host, access: 'default', prompt });
  const cleanup = async () => {
    for (const app of servers) { app.closeAllConnections(); if (app.listening) await new Promise<void>(r => app.close(() => r())); }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exit, new Promise(r => setTimeout(r, 1500))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    process.env = prior; rmSync(root, { recursive: true, force: true });
  };
  return { root, controller, observer, server, calls, launch, children, cleanup, starts: () => starts };
}

test('console security rejects cross-site, missing capability, unsafe fields and oversized bodies before host effects', async () => {
  const f = await fixture();
  try {
    const { origin, post } = await f.server();
    const bootstrap = await fetch(origin + '/api/console').then(r => r.json());
    assert.equal(bootstrap.token, f.controller.token);
    assert.equal((await post('/api/console/sessions', f.launch(), { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/console/sessions', f.launch(), { 'X-Crew-Token': '' })).status, 403);
    assert.equal((await fetch(origin + '/api/console/sessions', { method: 'POST', headers: { 'X-Crew-Token': f.controller.token, 'Content-Type': 'application/json' }, body: JSON.stringify(f.launch()) })).status, 403);
    assert.equal((await post('/api/console/sessions', { ...f.launch(), env: { TOKEN: 'private' } })).status, 400);
    assert.equal((await post('/api/console/sessions', { ...f.launch(), cwd: 'relative' })).status, 400);
    assert.equal((await post('/api/console/sessions', { ...f.launch(), model: '--dangerous' })).status, 400);
    assert.equal((await post('/api/console/sessions', { ...f.launch(), prompt: 'a'.repeat(70_000) })).status, 413);
    const unsupported = await post('/api/console/sessions', { ...f.launch(), host: 'claude', access: 'workspace' });
    assert.equal(unsupported.status, 409); assert.equal((await unsupported.json()).code, 'UNSUPPORTED_ACCESS');
    assert.equal(f.starts(), 0);
    const headers = await fetch(origin); assert.match(headers.headers.get('content-security-policy')!, /script-src 'self'/);
  } finally { await f.cleanup(); }
});

test('managed roots launch once, stream durable public chat, survive listener reload, retain exact identity and close deliberately', async () => {
  const f = await fixture();
  try {
    let app = await f.server();
    const result = await app.post('/api/console/sessions', f.launch()).then(r => r.json()) as ConsoleMutation;
    const id = result.session.id; assert.equal(result.command.state, 'delivered');
    assert.equal(f.starts(), 1);
    assert.ok(f.observer.snapshot().nodes.some(n => n.id === result.session.rootNodeId && n.role === 'root'));
    await waitFor(() => f.controller.detail(id)?.session.state === 'idle');
    const identity = readMeta(id, f.root)!.identity!.sessionId;
    const firstEvents = f.controller.detail(id)!.events;
    const duplicate = await app.post('/api/console/sessions', f.launch()).then(r => r.json()) as ConsoleMutation;
    assert.equal(duplicate.session.id, id); assert.equal(f.starts(), 1);
    assert.equal((await app.post('/api/console/sessions', f.launch('changed'))).status, 409);
    await new Promise<void>(r => app.app.close(() => r())); app = await f.server();
    assert.deepEqual(f.controller.detail(id)!.events, firstEvents);
    const input = { requestId: 'follow1', text: 'second' };
    const follow = await app.post(`/api/console/sessions/${id}/messages`, input).then(r => r.json()) as ConsoleMutation;
    assert.equal(follow.command.state, 'delivered');
    await waitFor(() => f.controller.detail(id)?.session.state === 'idle');
    await app.post(`/api/console/sessions/${id}/messages`, input);
    assert.equal(f.calls(id).filter(c => c.method === 'send' && c.requestId === 'follow1').length, 1);
    assert.equal(readMeta(id, f.root)!.identity!.sessionId, identity);
    assert.equal(f.controller.detail(id)!.events.filter(e => e.kind === 'user').length, 2);
    assert.ok(f.controller.detail(id)!.events.every(e => e.kind !== 'user' || e.command?.state === 'delivered'));
    const sse = await fetch(app.origin + `/api/events?session=${id}&node=${result.session.rootNodeId}`);
    const reader = sse.body!.getReader(); let stream = '';
    while (!stream.includes('event: update')) stream += new TextDecoder().decode((await reader.read()).value);
    assert.match(stream, /"console"/); assert.match(stream, /Response: second/); await reader.cancel();
    const session = f.controller.detail(id)!.session;
    const close = await app.post(`/api/console/sessions/${id}/actions`, { requestId: 'close1', action: 'close', revision: session.revision }).then(r => r.json()) as ConsoleMutation;
    assert.equal(close.session.state, 'closed'); assert.equal(close.command.state, 'delivered');
    assert.equal((await app.post(`/api/console/sessions/${id}/messages`, { requestId: 'late', text: 'late' })).status, 409);
    assert.equal((await app.post(`/api/console/sessions/${id}/actions`, { requestId: 'resumeclosed', action: 'resume', revision: close.session.revision })).status, 409);
    assert.equal(f.observer.snapshot().nodes.find(n => n.id === session.rootNodeId)!.state, 'stopped');
  } finally { await f.cleanup(); }
});

test('interrupt cancels pending requests, stale answers fail, explicit resume retains recorded provider identity', async () => {
  const f = await fixture();
  try {
    const result = await f.controller.launch(f.launch('approval'));
    const id = result.session.id;
    assert.equal(f.controller.detail(id)!.requests[0]!.kind, 'approval');
    await assert.rejects(f.controller.answer(id, { requestId: 'wrong', pendingRequestId: 'approval-1', option: 'invalid' }), /Invalid approval option/);
    const session = f.controller.detail(id)!.session;
    await f.controller.action(id, { requestId: 'interrupt', action: 'interrupt', revision: session.revision });
    assert.deepEqual(f.controller.detail(id)!.requests, []);
    await assert.rejects(f.controller.answer(id, { requestId: 'stale', pendingRequestId: 'approval-1', option: 'allow' }), /no longer pending/);
    const identity = readMeta(id, f.root)!.identity!.sessionId;
    await f.controller.action(id, { requestId: 'resume', action: 'resume', revision: f.controller.detail(id)!.session.revision });
    assert.equal(readMeta(id, f.root)!.identity!.sessionId, identity);
    const starts = f.calls(id).filter(c => c.method === 'start');
    assert.equal((starts[1]!.identity as { sessionId: string }).sessionId, identity);
    assert.equal(starts[0]!.envHasCrewRun, false);
    await f.controller.message(id, { requestId: 'question', text: 'question' });
    await f.controller.answer(id, { requestId: 'answer', pendingRequestId: 'question-1', answers: { color: 'Blue' } });
    assert.deepEqual(f.controller.detail(id)!.requests, []);
    await assert.rejects(f.controller.action(id, { requestId: 'staleaction', action: 'close', revision: 0 }), /Session changed/);
  } finally { await f.cleanup(); }
});

test('dead supervisor recovery marks ambiguous queued input uncertain and never replays it or adopts another identity', async () => {
  const f = await fixture();
  try {
    const result = await f.controller.launch(f.launch('hold'));
    const id = result.session.id; const identity = readMeta(id, f.root)!.identity!.sessionId;
    const child = f.children[0]!; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    acceptIntent(id, { kind: 'message', payload: { requestId: 'ambiguous', text: 'must-not-replay' } }, f.root);
    const meta = readMeta(id, f.root)!; meta.heartbeat = Date.now() - 20_000; writeJson(metaPath(id, f.root), meta);
    const view = readView(id, f.root)!; view.session.createdAt = new Date(Date.now() - 20_000).toISOString(); writeJson(viewPath(id, f.root), view);
    assert.equal(f.controller.detail(id)!.session.state, 'disconnected');
    await f.controller.action(id, { requestId: 'recover', action: 'resume', revision: view.session.revision });
    assert.equal(readReceipt(id, 'ambiguous', f.root)!.command.state, 'uncertain');
    assert.equal(f.calls(id).filter(c => c.text === 'must-not-replay').length, 0);
    assert.equal(readMeta(id, f.root)!.identity!.sessionId, identity);
    assert.equal(f.calls(id).filter(c => c.method === 'send' && c.requestId === 'launch1').length, 1);
    const message = await f.controller.message(id, { requestId: 'after-recover', text: 'third' }); assert.equal(message.command.state, 'delivered');
  } finally { await f.cleanup(); }
});

test('concurrent idempotent messages, failure receipts and descendant/mail observation preserve authority and cursors', async () => {
  const f = await fixture();
  try {
    const result = await f.controller.launch(f.launch('first')); const id = result.session.id;
    await waitFor(() => f.controller.detail(id)?.session.state === 'idle');
    const input = { requestId: 'concurrent', text: 'hold' };
    const pair = await Promise.all([f.controller.message(id, input), f.controller.message(id, input)]);
    assert.equal(pair[0]!.command.state, 'delivered'); assert.equal(pair[1]!.command.state, 'delivered');
    assert.equal(f.calls(id).filter(c => c.requestId === 'concurrent').length, 1);
    const identity = readMeta(id, f.root)!.identity!.sessionId;
    const mailbox = `codex-${identity}`;
    const child: RunMeta = { id: 'b-fixture', name: 'child', role: 'builder', route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' }, cwd: f.root, keep: false, parent: { mailbox, host: 'codex', threadId: identity }, launcher: 'exec', createdAt: new Date().toISOString(), state: 'running' };
    writeJson(join(f.root, 'runs', child.id, 'meta.json'), child);
    appendMail(mailbox, { id: 'mail1', at: new Date().toISOString(), from: { mailbox: child.id, host: 'codex' }, kind: 'message', text: 'agent advice' });
    const snapshot = f.observer.snapshot(); assert.equal(snapshot.nodes.find(n => n.id === child.id)!.parentId, result.session.rootNodeId);
    f.observer.detail(child.id);
    await waitFor(() => f.calls(id).some(c => typeof c.text === 'string' && c.text.startsWith('[crew]')));
    assert.equal(f.calls(id).filter(c => typeof c.text === 'string' && c.text.startsWith('[crew]')).length, 1);
    assert.throws(() => readFileSync(join(f.root, 'mail', mailbox, 'cursor')));
    assert.ok(!f.controller.detail(id)!.events.some(e => e.kind === 'user' && e.text.includes('[crew]')));
    await f.controller.message(id, { requestId: 'fail', text: 'transport-failure' });
    assert.equal(readReceipt(id, 'fail', f.root)!.command.state, 'uncertain');
    const failed = await f.controller.message(id, { requestId: 'fail', text: 'transport-failure' }); assert.equal(failed.command.state, 'uncertain');
    assert.equal(f.calls(id).filter(c => c.requestId === 'fail').length, 1);
    const bootstrap = JSON.stringify(f.controller.bootstrap()); assert.ok(!bootstrap.includes('instructions') && !bootstrap.includes('fixture-calls') && !bootstrap.includes('turnId'));
  } finally { await f.cleanup(); }
});

test('interrupt suspends child-mail wakes while close retires only the recorded descendant team and blocks late spawn', async () => {
  const f = await fixture();
  try {
    const result = await f.controller.launch(f.launch('hold')); const id = result.session.id;
    const identity = readMeta(id, f.root)!.identity!.sessionId; const mailbox = `codex-${identity}`;
    const at = new Date().toISOString();
    const make = (id: string, parent: string): RunMeta => ({ id, name: id, role: 'builder', route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' }, cwd: f.root, keep: true, parent: { mailbox: parent, host: 'codex' }, launcher: 'exec', createdAt: at, state: 'running' });
    for (const child of [make('b-owned', mailbox), make('b-grandchild', 'b-owned'), make('b-unrelated', 'codex-other')]) writeJson(join(f.root, 'runs', child.id, 'meta.json'), child);
    await f.controller.action(id, { requestId: 'pause', action: 'interrupt', revision: f.controller.detail(id)!.session.revision });
    appendMail(mailbox, { id: 'pausedmail', at, from: { mailbox: 'b-owned', host: 'codex' }, kind: 'message', text: 'paused advice' });
    // The latch survives a later host idle notification: unread mail does not undo an explicit interrupt.
    await new Promise(r => setTimeout(r, 400));
    assert.equal(f.calls(id).filter(c => typeof c.text === 'string' && c.text.startsWith('[crew]')).length, 0);
    assert.equal(f.controller.detail(id)!.session.state, 'interrupted');
    assert.equal(JSON.parse(readFileSync(join(f.root, 'runs', 'b-owned', 'meta.json'), 'utf8')).state, 'running');
    await f.controller.message(id, { requestId: 'continue', text: 'hold' });
    await waitFor(() => f.calls(id).some(c => typeof c.text === 'string' && c.text.startsWith('[crew]')));
    await waitFor(() => f.controller.detail(id)?.session.state === 'idle');
    const closed = await f.controller.action(id, { requestId: 'retire', action: 'close', revision: f.controller.detail(id)!.session.revision });
    assert.equal(closed.session.state, 'closed');
    for (const child of ['b-owned', 'b-grandchild']) assert.equal(JSON.parse(readFileSync(join(f.root, 'runs', child, 'meta.json'), 'utf8')).state, 'stopped');
    assert.equal(JSON.parse(readFileSync(join(f.root, 'runs', 'b-unrelated', 'meta.json'), 'utf8')).state, 'running');
    const { spawn } = await import('../src/spawn.ts');
    delete process.env.CREW_RUN; process.env.CODEX_THREAD_ID = identity;
    await assert.rejects(spawn({ role: 'builder', name: 'late', task: 'late', cwd: f.root, keep: false, model: 'codex/fixture', effort: 'high' }), /retired parent/);
    assert.ok(readFileSync(join(f.root, 'runs', 'b-owned', 'meta.json')));
  } finally { await f.cleanup(); }
});

test('failed team retirement is explicit, retryable and never reopens a deliberately retiring root', async () => {
  const f = await fixture();
  try {
    const result = await f.controller.launch(f.launch('hold')); const id = result.session.id;
    const mailbox = `codex-${readMeta(id, f.root)!.identity!.sessionId}`;
    const child: RunMeta = { id: 'b-failed-stop', name: 'failed-stop', role: 'builder', route: { host: 'claude', model: 'fixture', effort: 'high', strategy: 'pinned' }, cwd: f.root, keep: true, parent: { mailbox, host: 'codex' }, launcher: 'bg', bgId: 'fixture-bg', createdAt: new Date().toISOString(), state: 'running' };
    writeJson(join(f.root, 'runs', child.id, 'meta.json'), child);
    await assert.rejects(f.controller.action(id, { requestId: 'failed-close', action: 'close', revision: f.controller.detail(id)!.session.revision }), (error: unknown) => error instanceof ConsoleError && error.code === 'RETIREMENT_FAILED');
    assert.equal(f.controller.detail(id)!.session.state, 'failed');
    await assert.rejects(f.controller.action(id, { requestId: 'cannot-resume', action: 'resume', revision: f.controller.detail(id)!.session.revision }), (error: unknown) => error instanceof ConsoleError && error.code === 'SESSION_RETIRED');
    // Fixture reconciliation proves the recorded bg handle is gone; retry close can finish retirement.
    delete child.bgId; child.state = 'stopped'; writeJson(join(f.root, 'runs', child.id, 'meta.json'), child);
    const retry = await f.controller.action(id, { requestId: 'retry-close', action: 'close', revision: f.controller.detail(id)!.session.revision });
    assert.equal(retry.session.state, 'closed'); assert.equal(retry.command.state, 'delivered');
  } finally { await f.cleanup(); }
});
