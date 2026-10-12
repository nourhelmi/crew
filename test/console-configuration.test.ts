import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleController, hostCapabilities, rootInstructions } from '../src/console-controller.ts';
import { ConsoleSupervisor } from '../src/console-supervisor.ts';
import { childTargetId, prepareConsoleChild } from '../src/console-children.ts';
import { metaPath, readMeta, readReceipt, readView } from '../src/console-store.ts';
import { mailDir, readRun, writeJson, writeRun } from '../src/store.ts';
import type { HostOptions } from '../src/console-host.ts';
import type { RunMeta } from '../src/types.ts';

async function until<T>(read: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Configuration fixture timed out');
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-configure-')); const previous = { ...process.env };
  for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_CONSOLE_SESSION', 'CREW_ROUTER', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) delete process.env[key];
  Object.assign(process.env, { HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') });
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: [], claude: [] } });
  writeJson(process.env.CREW_ROSTER!, { models: [] });
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin/herdr'), '#!/bin/sh\nexit 99\n', { mode: 0o755 }); process.env.PATH = `${join(root, 'bin')}:${previous.PATH}`;
  const starts: { id: string; options: HostOptions }[] = []; const sends: { id: string; text: string; model: string | undefined }[] = []; const closes: string[] = [];
  const owners = new Map<string, ConsoleSupervisor>(); const hosts = new Map<string, HostOptions>();
  const failures = new Set<string>();
  const makeOwner = (id: string) => new ConsoleSupervisor(id, { root, factory: options => {
    hosts.set(id, options);
    return { capabilities: hostCapabilities('codex'),
      async start() { starts.push({ id, options }); if (failures.has(id)) throw new Error('fixture configuration failed'); options.callbacks.identity({ sessionId: options.identity?.sessionId ?? `native-${id}` }); options.callbacks.state('idle'); },
      async send(text) { sends.push({ id, text, model: options.launch.model }); options.callbacks.state('running'); return 'delivered'; },
      async interrupt() { options.callbacks.state('interrupted'); },
      async answer(answer) { options.callbacks.cancelRequest(answer.pendingRequestId); options.callbacks.state('idle'); },
      async close() { closes.push(id); },
    };
  } });
  const controller = new ConsoleController({ root, receiptWaitMs: 5,
    providers: () => [{ id: 'codex', label: 'fixture', available: true, capabilities: hostCapabilities('codex'), models: [{ id: 'model-a', label: 'A', efforts: ['high'] }, { id: 'model-b', label: 'B', efforts: ['max'] }] }],
    startSupervisor: async id => { const owner = makeOwner(id); owners.set(id, owner); assert.equal(await owner.start(), true); } });
  const id = (await controller.launch({ requestId: 'launch', cwd: root, host: 'codex', model: 'model-a', effort: 'high', mode: 'advisor', prompt: 'Initial work' })).session.id;
  const parent = { mailbox: `codex-${readMeta(id, root)!.identity!.sessionId}`, host: 'codex' as const };
  mkdirSync(mailDir(parent.mailbox), { recursive: true }); writeFileSync(join(mailDir(parent.mailbox), 'watcher'), String(process.pid));
  const worker = async () => {
    const run: RunMeta = { id: 'b-worker', name: 'worker', role: 'builder', route: { host: 'codex', model: 'model-a', effort: 'high', strategy: 'pinned' }, cwd: root, keep: true,
      launcher: 'console', console: { sessionId: childTargetId('b-worker'), rootSessionId: id }, parent, createdAt: new Date().toISOString(), state: 'running' };
    writeRun(run); prepareConsoleChild(run, root); await controller.launchChild(run); return readRun(run.id)!;
  };
  const completed = (requestId: string) => until(() => { const r = readReceipt(id, requestId, root); return r?.phase === 'complete' && r; });
  return { root, id, controller, owners, hosts, starts, sends, closes, failures, makeOwner, worker, completed,
    async cleanup() { failures.clear(); for (const owner of owners.values()) await owner.suspend(); process.env = previous; rmSync(root, { recursive: true, force: true }); } };
}

test('queued lead configuration preserves decisions and workers, then applies before later input with the exact root identity', async () => {
  const f = await fixture();
  try {
    const worker = await f.worker(); const workerBefore = readMeta(worker.console!.sessionId, f.root)!;
    const identity = readMeta(f.id, f.root)!.identity!.sessionId;
    const input = { requestId: 'configuration', revision: f.controller.session(f.id)!.revision, host: 'codex', model: 'model-b', effort: 'max', mode: 'cos' };
    assert.equal((await f.controller.configure(f.id, input)).command.state, 'queued');
    const callback = f.hosts.get(f.id)!.callbacks;
    callback.request({ id: 'decision', kind: 'approval', title: 'Approve', description: 'fixture', options: [{ id: 'allow', label: 'Allow' }] });
    assert.equal((await f.controller.message(f.id, { requestId: 'later-message', text: 'Next work' })).command.state, 'queued');
    assert.equal(f.controller.session(f.id)!.model, 'model-a'); assert.equal(f.controller.session(f.id)!.mode, 'advisor');
    assert.equal(f.controller.requests(f.id)[0]!.id, 'decision'); assert.equal(f.starts.filter(row => row.id === f.id).length, 1);
    await f.controller.answer(f.id, { requestId: 'answer', pendingRequestId: 'decision', option: 'allow' });
    assert.equal((await f.completed('configuration')).command.state, 'delivered');
    assert.equal((await f.completed('later-message')).command.state, 'delivered');
    assert.equal(readMeta(f.id, f.root)!.identity!.sessionId, identity);
    assert.equal(f.starts.filter(row => row.id === f.id).at(-1)!.options.identity!.sessionId, identity);
    assert.match(f.hosts.get(f.id)!.instructions, /explicit --mode cos/);
    assert.equal(f.hosts.get(f.id)!.instructionsChanged, true);
    assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, undefined);
    assert.equal(f.sends.at(-1)!.model, 'model-b');
    assert.equal(f.controller.session(f.id)!.model, 'model-b'); assert.equal(f.controller.session(f.id)!.mode, 'cos');
    assert.deepEqual(readMeta(worker.console!.sessionId, f.root)!.launch, workerBefore.launch);
    assert.deepEqual(readMeta(worker.console!.sessionId, f.root)!.identity, workerBefore.identity);
    assert.equal(f.closes.includes(worker.console!.sessionId), false);
    assert.equal((await f.controller.configure(f.id, input)).command.state, 'delivered');
    assert.equal(f.starts.filter(row => row.id === f.id).length, 2);
    await assert.rejects(f.controller.configure(f.id, { ...input, mode: 'advisor' }), /different input/);
  } finally { await f.cleanup(); }
});

test('suspended selection is durable without starting providers and a stale recovery owner loads the new selection', async () => {
  const f = await fixture();
  try {
    const identity = readMeta(f.id, f.root)!.identity;
    await f.controller.suspend(f.id);
    const staleOwner = f.makeOwner(f.id);
    const result = await f.controller.configure(f.id, { requestId: 'offline', revision: f.controller.session(f.id)!.revision, model: 'model-b', effort: 'max', mode: 'cos' });
    assert.equal(result.command.state, 'delivered'); assert.equal(result.session.state, 'disconnected');
    assert.equal(f.starts.length, 1); assert.deepEqual(readMeta(f.id, f.root)!.identity, identity);
    assert.equal(readMeta(f.id, f.root)!.suspended, true); assert.match(readMeta(f.id, f.root)!.instructions, /explicit --mode cos/);
    assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, true);
    f.owners.set(f.id, staleOwner); assert.equal(await staleOwner.start(), true);
    assert.equal(f.controller.session(f.id)!.model, 'model-b');
    await f.controller.action(f.id, { requestId: 'recover', action: 'resume', revision: f.controller.session(f.id)!.revision });
    await f.completed('recover');
    assert.equal(f.hosts.get(f.id)!.launch.model, 'model-b'); assert.equal(f.hosts.get(f.id)!.identity!.sessionId, identity!.sessionId);
    assert.equal(f.hosts.get(f.id)!.instructionsChanged, true); assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, undefined);
    assert.equal(f.sends.length, 1, 'configuration and recovery cannot fabricate a prompt');
  } finally { await f.cleanup(); }
});

test('configuration validates native host and effective effort; failed connection retains the prior durable selection', async () => {
  const f = await fixture();
  try {
    const revision = f.controller.session(f.id)!.revision;
    await assert.rejects(f.controller.configure(f.id, { requestId: 'cross-host', revision, host: 'claude', model: 'model-b' }), /current native provider/);
    await assert.rejects(f.controller.configure(f.id, { requestId: 'bad-effort', revision, model: 'model-b' }), /supported effort/);
    f.hosts.get(f.id)!.callbacks.state('idle'); f.failures.add(f.id);
    await f.controller.configure(f.id, { requestId: 'failed-change', revision: f.controller.session(f.id)!.revision, mode: 'cos', model: 'model-b', effort: 'max' });
    assert.equal((await f.completed('failed-change')).command.state, 'uncertain');
    assert.equal(readMeta(f.id, f.root)!.launch.model, 'model-a'); assert.equal(readMeta(f.id, f.root)!.launch.mode, 'advisor');
    assert.equal(f.controller.session(f.id)!.model, 'model-a'); assert.equal(f.controller.session(f.id)!.state, 'disconnected');
    assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, true);
    f.failures.clear();
    await f.controller.action(f.id, { requestId: 'repair-instructions', action: 'resume', revision: f.controller.session(f.id)!.revision });
    await f.completed('repair-instructions');
    assert.equal(f.hosts.get(f.id)!.instructionsChanged, true); assert.match(f.hosts.get(f.id)!.instructions, /explicit --mode advisor/);
    assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, undefined);
  } finally { await f.cleanup(); }
});

test('suspension settles queued configuration and following input without applying or replaying them', async () => {
  const f = await fixture();
  try {
    await f.controller.configure(f.id, { requestId: 'queued-config', revision: f.controller.session(f.id)!.revision, mode: 'cos' });
    await f.controller.message(f.id, { requestId: 'queued-message', text: 'Must stay unsent' });
    await f.controller.suspend(f.id);
    assert.equal((await f.completed('queued-config')).command.state, 'failed');
    assert.equal((await f.completed('queued-message')).command.state, 'failed');
    assert.equal(readMeta(f.id, f.root)!.launch.mode, 'advisor'); assert.equal(f.starts.length, 1); assert.equal(f.sends.length, 1);
  } finally { await f.cleanup(); }
});

test('a provider failure settles queued configuration instead of blocking recovery indefinitely', async () => {
  for (const state of ['failed', 'disconnected'] as const) {
    const f = await fixture();
    try {
      await f.controller.configure(f.id, { requestId: 'queued-config', revision: f.controller.session(f.id)!.revision, mode: 'cos' });
      f.hosts.get(f.id)!.callbacks.state(state, 'fixture transport lost');
      const receipt = await f.completed('queued-config');
      assert.equal(receipt.command.state, 'failed'); assert.match(receipt.command.error!, /disconnected before/);
      assert.equal(readMeta(f.id, f.root)!.launch.mode, 'advisor'); assert.equal(f.starts.length, 1);
    } finally { await f.cleanup(); }
  }
});

test('committed selection survives a crash before the public projection is written', async () => {
  const f = await fixture();
  try {
    await f.controller.suspend(f.id);
    const meta = readMeta(f.id, f.root)!;
    // This is the actual configuration commit window: native/private selection
    // has changed, while the independently written public view is still old.
    writeJson(metaPath(f.id, f.root), { ...meta, launch: { ...meta.launch, model: 'model-b', effort: 'max', mode: 'cos' }, instructions: rootInstructions('cos') });
    assert.equal(readView(f.id, f.root)!.session.model, 'model-a');
    assert.equal(f.controller.session(f.id)!.model, 'model-b'); assert.equal(f.controller.session(f.id)!.mode, 'cos');
    await f.controller.action(f.id, { requestId: 'recover-commit', action: 'resume', revision: f.controller.session(f.id)!.revision });
    await f.completed('recover-commit');
    assert.equal(readView(f.id, f.root)!.session.model, 'model-b');
    assert.equal(f.hosts.get(f.id)!.launch.model, 'model-b'); assert.equal(f.hosts.get(f.id)!.identity!.sessionId, meta.identity!.sessionId);
  } finally { await f.cleanup(); }
});

test('model-only configuration does not append another workflow contract', async () => {
  const f = await fixture();
  try {
    f.hosts.get(f.id)!.callbacks.state('idle');
    await f.controller.configure(f.id, { requestId: 'model-only', revision: f.controller.session(f.id)!.revision, model: 'model-b', effort: 'max' });
    assert.equal((await f.completed('model-only')).command.state, 'delivered');
    assert.equal(f.hosts.get(f.id)!.instructionsChanged, undefined);
    assert.equal(readMeta(f.id, f.root)!.instructionsRefresh, undefined);
    assert.equal(f.controller.session(f.id)!.mode, 'advisor');
  } finally { await f.cleanup(); }
});
