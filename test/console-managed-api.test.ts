import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleController, hostCapabilities } from '../src/console-controller.ts';
import { ConsoleSupervisor } from '../src/console-supervisor.ts';
import { childTargetId, prepareConsoleChild } from '../src/console-children.ts';
import { appendConsoleChanges, consoleEvents, metaPath, readMeta, readView, sessionDir, writeView } from '../src/console-store.ts';
import { mailDir, packetPath, readRun, resultPath, runDir, unread, updateRun, writeJson, writeRun } from '../src/store.ts';
import { amend, stall, takeUnread } from '../src/mail.ts';
import { resume, resuming } from '../src/resume.ts';
import { watch } from '../src/wait.ts';
import type { HostOptions } from '../src/console-host.ts';
import type { ConsoleChange } from '../src/console-types.ts';
import type { RunMeta } from '../src/types.ts';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-managed-api-'));
  const previous = { ...process.env };
  for (const name of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_CONSOLE_SESSION', 'CREW_ROUTER', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete process.env[name];
  Object.assign(process.env, { HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ADVISOR_STATE_DIR: join(root, 'advisor') });
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin', 'herdr'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${previous.PATH}`;
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: [], claude: [] } });
  writeJson(process.env.CREW_ROSTER!, { models: [] });
  const owners = new Map<string, ConsoleSupervisor>(); const hosts = new Map<string, HostOptions>();
  const hooks = new Map<string, { start?: () => Promise<void>; close?: () => Promise<void> }>();
  const sends: { target: string; text: string; requestId: string }[] = []; const closed: string[] = [];
  const controller = new ConsoleController({ root, providers: () => [{ id: 'codex', label: 'fixture', available: true, models: [], capabilities: hostCapabilities('codex') }],
    startSupervisor: async id => {
      const supervisor = new ConsoleSupervisor(id, { root, factory: options => {
        hosts.set(id, options);
        return { capabilities: hostCapabilities('codex'),
          async start() { await hooks.get(id)?.start?.(); options.callbacks.identity({ sessionId: options.identity?.sessionId ?? `native-${id}` }); options.callbacks.state('idle'); },
          async send(text, requestId) { sends.push({ target: id, text, requestId }); return 'delivered'; },
          async interrupt() { options.callbacks.state('interrupted'); }, async answer() {},
          async close() { await hooks.get(id)?.close?.(); closed.push(id); options.callbacks.state('closed'); },
        };
      } }); owners.set(id, supervisor); assert.equal(await supervisor.start(), true);
    } });
  const rootSession = (await controller.launch({ requestId: 'root', cwd: root, mode: 'advisor', host: 'codex', prompt: 'Initial root' })).session.id;
  const parent = { mailbox: `codex-${readMeta(rootSession, root)!.identity!.sessionId}`, host: 'codex' as const };
  // The process itself represents a live parent watcher; no detached process is spawned.
  mkdirSync(mailDir(parent.mailbox), { recursive: true }); writeFileSync(join(mailDir(parent.mailbox), 'watcher'), String(process.pid));
  const child = async (id = 'b-child', parentRun?: RunMeta) => {
    const run: RunMeta = { id, name: id, role: 'builder', route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' }, cwd: root, keep: true, launcher: 'console',
      console: { sessionId: childTargetId(id), rootSessionId: rootSession }, parent: parentRun ? { mailbox: parentRun.id, host: 'codex' } : parent, createdAt: new Date().toISOString(), state: 'running' };
    writeRun(run); writeFileSync(packetPath(id), '# Packet\nOriginal scope\n'); writeFileSync(resultPath(id), '# Status\nIN PROGRESS\n');
    mkdirSync(mailDir(id), { recursive: true }); writeFileSync(join(mailDir(id), 'watcher'), String(process.pid));
    prepareConsoleChild(run, root); await controller.launchChild(run); return readRun(id)!;
  };
  return { root, controller, rootSession, parent, child, hosts, owners, sends, closed, hooks,
    async cleanup() { hooks.clear(); for (const owner of owners.values()) await owner.suspend(); process.env = previous; rmSync(root, { recursive: true, force: true }); } };
}

function allEvents(id: string, root: string, cursor?: string): ReturnType<typeof consoleEvents> {
  const changes: ReturnType<typeof consoleEvents>['changes'] = [];
  let page = consoleEvents(id, cursor, 100, root); const gap = page.gap;
  changes.push(...page.changes);
  while (page.more) { page = consoleEvents(id, page.cursor, 100, root); changes.push(...page.changes); }
  return { ...page, changes, ...(gap ? { gap } : {}) };
}

test('event cursors preserve long text, streaming updates, requests and history beyond bounded views', async () => {
  const f = await fixture();
  try {
    const initial = allEvents(f.rootSession, f.root);
    const callback = f.hosts.get(f.rootSession)!.callbacks;
    const full = '漢'.repeat(30_000);
    callback.event({ kind: 'assistant', key: 'stream', text: full, streaming: true });
    callback.event({ kind: 'assistant', key: 'stream', text: full + ' finished', streaming: false });
    callback.request({ id: 'approve', kind: 'approval', title: 'Permission', description: 'Isolated fixture', options: [{ id: 'yes', label: 'Allow' }] });
    callback.cancelRequest('approve');
    const updates = allEvents(f.rootSession, f.root, initial.cursor);
    const assistant = updates.changes.filter(change => change.kind === 'event' && change.event.kind === 'assistant');
    assert.equal(assistant.length, 2);
    if (assistant[0]!.kind !== 'event' || assistant[1]!.kind !== 'event') throw new Error('Missing stream');
    assert.equal(assistant[0]!.event.id, assistant[1]!.event.id);
    assert.equal(assistant[1]!.event.text, full + ' finished');
    assert.equal(f.controller.detail(f.rootSession)!.events.at(-1)!.text.length, 24_000);
    assert.ok(updates.changes.some(change => change.kind === 'requests' && change.requests[0]?.id === 'approve'));
    assert.ok(updates.changes.some(change => change.kind === 'requests' && change.requests.length === 0));
    const view = readView(f.rootSession, f.root)!;
    const historical: ConsoleChange[] = Array.from({ length: 2505 }, (_, i) => ({ kind: 'event', event: { kind: 'status', id: `historical-${i}`, sequence: 100 + i, at: new Date().toISOString(), text: `Complete ${i}` } }));
    appendConsoleChanges(f.rootSession, historical, f.root);
    view.events = historical.flatMap(change => change.kind === 'event' ? [change.event] : []); writeView(f.rootSession, view, f.root);
    assert.equal(readView(f.rootSession, f.root)!.events.length, 2500);
    assert.equal(allEvents(f.rootSession, f.root, updates.cursor).changes.length, 2505);
    assert.equal(consoleEvents(f.rootSession, updates.cursor, 1, f.root).more, true);
    assert.equal(consoleEvents(f.rootSession, 'bad-cursor', 1, f.root).gap!.reason, 'invalid');
    assert.equal(consoleEvents(f.rootSession, '0'.repeat(32) + ':100', 1, f.root).gap!.reason, 'expired');
    assert.equal(statSync(join(sessionDir(f.rootSession, f.root), 'events.jsonl')).mode & 0o777, 0o600);
    const journal = join(sessionDir(f.rootSession, f.root), 'events.jsonl');
    const tail = allEvents(f.rootSession, f.root).cursor;
    appendFileSync(journal, '{"kind":"requests","requests":[]');
    const partial = consoleEvents(f.rootSession, tail, 10, f.root); assert.equal(partial.cursor, tail); assert.equal(partial.changes.length, 0); assert.equal(partial.more, true);
    appendFileSync(journal, '}\n'); assert.equal(consoleEvents(f.rootSession, tail, 10, f.root).changes.length, 1);
    const beforeCrash = allEvents(f.rootSession, f.root).cursor;
    appendFileSync(journal, '{"kind":"event","event":');
    appendConsoleChanges(f.rootSession, [{ kind: 'requests', requests: [] }], f.root);
    const recovered = consoleEvents(f.rootSession, beforeCrash, 10, f.root);
    assert.equal(recovered.gap!.reason, 'interrupted-write'); assert.equal(recovered.changes.length, 1);
    unlinkSync(journal); assert.equal(consoleEvents(f.rootSession, undefined, 1, f.root).gap!.reason, 'legacy');
  } finally { await f.cleanup(); }
});

test('suspension releases every owned runtime without retiring packets and exact resume remains explicit', async () => {
  const f = await fixture();
  try {
    const child = await f.child(); const nested = await f.child('b-nested', child);
    const identity = readMeta(f.rootSession, f.root)!.identity!.sessionId;
    await f.controller.suspend(f.rootSession);
    assert.equal(f.controller.detail(f.rootSession)!.session.state, 'disconnected');
    assert.equal(readMeta(f.rootSession, f.root)!.pid, undefined);
    for (const run of [child, nested]) {
      assert.equal(readRun(run.id)!.state, 'running'); assert.equal(readMeta(childTargetId(run.id), f.root)!.pid, undefined);
      assert.equal(f.controller.childDetail(f.rootSession, run.id)!.child.state, 'disconnected');
    }
    assert.deepEqual(new Set(f.closed), new Set([f.rootSession, childTargetId(child.id), childTargetId(nested.id)]));
    await assert.rejects(f.controller.message(f.rootSession, { requestId: 'late', text: 'No implicit resume' }), /disconnected/);
    await f.controller.action(f.rootSession, { requestId: 'explicit-resume', action: 'resume', revision: f.controller.detail(f.rootSession)!.session.revision });
    assert.equal(readMeta(f.rootSession, f.root)!.identity!.sessionId, identity);
    assert.equal(f.controller.childDetail(f.rootSession, child.id)!.child.state, 'disconnected');
  } finally { await f.cleanup(); }
});

test('MCP credentials refresh only after every owned pipe is suspended, without changing identities or public output', async () => {
  const f = await fixture();
  try {
    const child = await f.child();
    const rootIdentity = readMeta(f.rootSession, f.root)!.identity;
    const childIdentity = readMeta(childTargetId(child.id), f.root)!.identity;
    const servers = [{ name: 'fixture', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'private-fixture-token' }] }];
    assert.throws(() => f.controller.refreshMcp(f.rootSession, servers), /Suspend/);
    await f.owners.get(f.rootSession)!.suspend();
    assert.throws(() => f.controller.refreshMcp(f.rootSession, servers), /Suspend/);
    assert.equal(readMeta(f.rootSession, f.root)!.launch.mcpServers, undefined);
    await f.controller.suspend(f.rootSession);
    f.controller.refreshMcp(f.rootSession, servers);
    assert.deepEqual(readMeta(f.rootSession, f.root)!.identity, rootIdentity);
    assert.deepEqual(readMeta(childTargetId(child.id), f.root)!.identity, childIdentity);
    assert.deepEqual(readMeta(childTargetId(child.id), f.root)!.launch.mcpServers, servers);
    assert.equal(statSync(metaPath(f.rootSession, f.root)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(f.controller.bootstrap()), /private-fixture-token/);
    assert.doesNotMatch(JSON.stringify(allEvents(f.rootSession, f.root)), /private-fixture-token/);
    const beforeRead = new ConsoleSupervisor(f.rootSession, { root: f.root, factory: options => {
      assert.deepEqual(options.launch.mcpServers, []);
      return { capabilities: hostCapabilities('codex'), async start() { options.callbacks.identity(rootIdentity!); options.callbacks.state('idle'); }, async send() { return 'delivered'; }, async interrupt() {}, async answer() {}, async close() {} };
    } });
    // A supervisor constructed before refresh must bind the private config only when it wins ownership.
    f.controller.refreshMcp(f.rootSession, []);
    assert.equal(await beforeRead.start(), true);
    f.owners.set(f.rootSession, beforeRead);
    await f.controller.action(f.rootSession, { requestId: 'refresh-resume', action: 'resume', revision: f.controller.session(f.rootSession)!.revision });
    assert.equal(readMeta(f.rootSession, f.root)!.identity!.sessionId, rootIdentity!.sessionId);
  } finally { await f.cleanup(); }
});

test('intentional suspension does not stall amended work; confirmed resume resets only the active liveness episode', async () => {
  const f = await fixture();
  try {
    const child = await f.child(); const target = childTargetId(child.id);
    await f.controller.suspend(f.rootSession);
    assert.equal(readMeta(target, f.root)!.suspended, true);
    amend(f.parent, child.id, 'Continue after explicit reconnect.');
    await watch(f.parent.mailbox, 5, 30);
    assert.equal(readRun(child.id)!.state, 'running');
    assert.equal(takeUnread(f.parent.mailbox).some(mail => mail.kind === 'stalled'), false);
    await f.controller.action(f.rootSession, { requestId: 'root-resume', action: 'resume', revision: f.controller.session(f.rootSession)!.revision });
    const observed = updateRun(child.id, run => ({ ...run, state: 'stalled' }))!;
    writeFileSync(join(runDir(child.id), '.stalled'), 'previous episode');
    const accepted = await f.controller.childAction(f.rootSession, child.id, { requestId: 'child-resume', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision });
    assert.equal(accepted.command.state, 'delivered');
    assert.equal(readMeta(target, f.root)!.suspended, undefined);
    assert.equal(readRun(child.id)!.sessionId, child.sessionId);
    assert.equal(readRun(child.id)!.state, 'running');
    assert.equal(readRun(child.id)!.turn, (observed.turn ?? 0) + 1);
    assert.equal(existsSync(join(runDir(child.id), '.stalled')), false);
    assert.equal(unread(child.id).mails.some(mail => mail.kind === 'amendment'), true, 'reconnect cannot consume packet mail');
    assert.equal(stall(child.id, 'obsolete probe', observed), undefined);
    takeUnread(child.id); // Only the worker's inbox read consumes the amendment.
    writeFileSync(resultPath(child.id), '# Status\nDONE: resumed assignment\n');
    await watch(f.parent.mailbox, 5, 30);
    assert.equal(readRun(child.id)!.state, 'idle');
    assert.equal(takeUnread(f.parent.mailbox).some(mail => mail.kind === 'settled'), true);
    const submitted = readRun(child.id)!.assignment;
    await f.controller.childAction(f.rootSession, child.id, { requestId: 'settled-resume', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision });
    assert.equal(readRun(child.id)!.state, 'idle');
    assert.deepEqual(readRun(child.id)!.assignment, submitted);
  } finally { await f.cleanup(); }
});

test('failed suspension and failed or stopped reconnect remain visible and never clear stale-stall evidence', async () => {
  const f = await fixture();
  try {
    const child = await f.child(); const target = childTargetId(child.id);
    f.hooks.set(target, { close: async () => { throw new Error('fixture close failed'); } });
    await assert.rejects(f.owners.get(target)!.suspend(), /close failed/);
    assert.equal(readMeta(target, f.root)!.suspended, undefined);
    f.hooks.delete(target);
    await f.owners.get(target)!.suspend();
    f.hooks.set(target, { start: async () => { throw new Error('fixture reconnect failed'); } });
    const failed = await f.controller.childAction(f.rootSession, child.id, { requestId: 'failed-reconnect', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision });
    assert.notEqual(failed.command.state, 'delivered');
    assert.equal(readMeta(target, f.root)!.suspended, undefined);
    assert.equal(readMeta(target, f.root)!.mailPaused, true);
    await watch(f.parent.mailbox, 5, 30);
    assert.equal(readRun(child.id)!.state, 'stalled');
    assert.equal(existsSync(join(runDir(child.id), '.stalled')), true);
    assert.equal(takeUnread(f.parent.mailbox).some(mail => mail.kind === 'stalled'), true);
    await f.controller.childAction(f.rootSession, child.id, { requestId: 'still-failing', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision });
    assert.equal(readRun(child.id)!.state, 'stalled');
    assert.equal(existsSync(join(runDir(child.id), '.stalled')), true);
    f.hooks.set(target, { start: async () => { updateRun(child.id, run => ({ ...run, state: 'stopped' })); } });
    await assert.rejects(f.controller.childAction(f.rootSession, child.id, { requestId: 'stopped-reconnect', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision }), /retired|disconnected/);
    assert.equal(readRun(child.id)!.state, 'stopped');
    assert.equal(existsSync(join(runDir(child.id), '.stalled')), true);
  } finally { await f.cleanup(); }
});

test('CLI managed resume serializes concurrent attempts and queued receipts never claim delivery', async t => {
  const f = await fixture();
  try {
    const child = await f.child();
    let calls = 0;
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const mock = t.mock.method(ConsoleController.prototype, 'childAction', async () => {
      calls++; assert.equal(resuming(child.id), true); entered.resolve(); await release.promise;
      updateRun(child.id, run => ({ ...run, turn: (run.turn ?? 0) + 1 }));
      return { child: f.controller.childDetail(f.rootSession, child.id)!.child, command: { requestId: 'confirmed', state: 'delivered' as const } };
    });
    const first = resume(child.id, true); await entered.promise;
    const second = resume(child.id, true); release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, false]); assert.equal(calls, 1);
    mock.mock.mockImplementation(async () => ({ child: f.controller.childDetail(f.rootSession, child.id)!.child, command: { requestId: 'queued', state: 'queued' as const } }));
    assert.equal(await resume(child.id, true), false);
    updateRun(child.id, run => ({ ...run, state: 'stopped' }));
    await assert.rejects(resume(child.id, true), /stopped/);
  } finally { await f.cleanup(); }
});

test('reconnect reports the original startup error when provider cleanup also fails', async () => {
  const f = await fixture();
  try {
    const child = await f.child(); const target = childTargetId(child.id);
    f.hooks.set(target, { start: async () => {
      f.hooks.set(target, { close: async () => { throw new Error('fixture cleanup error'); } });
      throw new Error('fixture primary startup error');
    } });
    const result = await f.controller.childAction(f.rootSession, child.id, { requestId: 'double-failure', action: 'resume', revision: f.controller.childDetail(f.rootSession, child.id)!.child.revision });
    assert.match(result.command.error!, /primary startup error.*cleanup error/);
    assert.equal(f.controller.childDetail(f.rootSession, child.id)!.child.state, 'disconnected');
    assert.equal(readMeta(target, f.root)!.suspended, undefined);
  } finally { await f.cleanup(); }
});
