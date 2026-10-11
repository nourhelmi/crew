import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, beforeEach, describe, it } from 'node:test';
import type { RunMeta } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'crew-assignments-'));
const bin = join(dir, 'bin'); mkdirSync(bin);
for (const command of ['herdr', 'codex', 'claude', 'opencode', 'agent-router']) {
  writeFileSync(join(bin, command), '#!/bin/sh\necho "unexpected host invocation" >&2\nexit 99\n', { mode: 0o755 });
}
process.env.PATH = `${bin}:${process.env.PATH}`;
Object.assign(process.env, { HOME: dir, CREW_HOME: join(dir, 'crew'), CREW_CONFIG: join(dir, 'config.json'),
  CREW_ROSTER: join(dir, 'roster.json'), CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'),
  CODEX_THREAD_ID: 'root', CREW_NO_DELEGATE: '1' });
for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID', 'CREW_CODEX_SOCKET']) delete process.env[key];
const store = await import('../src/store.ts');
const mail = await import('../src/mail.ts');
const { readResult } = await import('../src/result.ts');
const { accept, activeDescendants } = await import('../src/assignment.ts');
const { liveChildren, watch } = await import('../src/wait.ts');
const { runHook } = await import('../src/hook.ts');
const CLI = resolve('bin/crew');
const parent = { host: 'codex' as const, mailbox: 'codex-root' };
const peer = { host: 'codex' as const, mailbox: 'codex-peer' };
const exec = promisify(execFile);
const cli = (args: string[]) => execFileSync(CLI, args, { env: process.env, encoding: 'utf8' }).trim();
const result = (text: string, id = 'a-test') => writeFileSync(store.resultPath(id), `# Status\n${text}\n# Claims\nfixture\n`);
const ref = (id = 'a-test') => store.readRun(id)!.assignment!.submission!;
const fixture = (extra: Partial<RunMeta> = {}) => {
  const run: RunMeta = { id: 'a-test', name: 'advisor', role: 'advisor', keep: true, cwd: dir, parent,
    route: { host: 'codex', model: 'gpt-6.1-sol', effort: 'low', strategy: 'pinned' }, launcher: 'exec',
    createdAt: new Date().toISOString(), state: 'running', ...extra };
  store.writeRun(run); writeFileSync(store.packetPath(run.id), 'initial packet\n'); return run;
};
beforeEach(() => rmSync(store.home(), { recursive: true, force: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('retained assignments and exact acceptance', () => {
  it('submits immutable evidence, accepts exactly, invalidates on amendment, repairs and reuses the member', () => {
    fixture(); result('DONE: initial'); mail.settle('a-test');
    const first = ref(); const snapshot = readFileSync(store.readRun('a-test')!.assignment!.submissions[0]!.result, 'utf8');
    assert.equal(store.readRun('a-test')!.state, 'idle');
    assert.equal(store.readRun('a-test')!.assignment!.status, 'submitted');
    assert.equal(liveChildren(parent.mailbox).length, 0);
    assert.match(cli(['accept', 'advisor', first]), new RegExp(first));
    assert.equal(store.readRun('a-test')!.assignment!.accepted!.submission, first);
    mail.amend(parent, 'advisor', 'repair current outcome');
    assert.equal(store.readRun('a-test')!.assignment!.id, 'initial');
    assert.equal(store.readRun('a-test')!.assignment!.status, 'active');
    assert.equal(store.readRun('a-test')!.assignment!.accepted, undefined);
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
    result('DONE: repaired'); assert.equal(mail.settle('a-test'), undefined, 'unread amendment prevents submission');
    mail.takeUnread('a-test'); mail.settle('a-test'); const repaired = ref();
    assert.notEqual(repaired, first); assert.throws(() => accept(parent, 'advisor', first), /stale/);
    accept(parent, 'advisor', repaired);
    const packet = join(dir, 'next.md'); writeFileSync(packet, 'second outcome');
    assert.match(cli(['assign', 'advisor', '--packet', packet]), /assignment task-/);
    const assigned = store.readRun('a-test')!;
    assert.equal(assigned.id, 'a-test'); assert.equal(assigned.route.model, 'gpt-6.1-sol');
    assert.equal(assigned.assignmentHistory!.length, 1);
    assert.equal(assigned.assignmentHistory![0]!.accepted!.submission, repaired);
    assert.equal(assigned.assignmentHistory![0]!.submissions[0]!.accepted!.submission, first);
    assert.equal(readFileSync(store.packetPath('a-test'), 'utf8'), 'second outcome\n');
    result('DONE: second'); assert.equal(mail.settle('a-test'), undefined);
    mail.takeUnread('a-test'); mail.settle('a-test'); accept(parent, 'advisor', ref());
    assert.equal(cli(['read', 'advisor', '--submission', first]), snapshot.trim());
    assert.equal(JSON.parse(cli(['read', 'advisor', '--json'])).history.length, 1);
    assert.equal(store.readRun('a-test')!.assignment!.status, 'accepted');
  });

  it('rejects unauthorized/stale acceptance and replacement results even without observing a draft', () => {
    fixture(); result('DONE: A'); mail.settle('a-test'); const first = ref();
    assert.throws(() => accept(peer, 'advisor', first), /only advisor's parent/);
    assert.throws(() => mail.assign(peer, 'advisor', 'different work'), /only advisor's parent/);
    accept(parent, 'advisor', first); result('DONE: B');
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
    mail.settle('a-test'); const second = ref(); assert.notEqual(second, first);
    result('DONE: A'); mail.settle('a-test'); assert.notEqual(ref(), first, 'old content cannot resurrect an old acceptance');
    assert.throws(() => accept(parent, 'advisor', second), /stale/);
    assert.equal(store.readRun('a-test')!.assignment!.accepted, undefined);
    accept(parent, 'advisor', ref());
  });

  it('invalidates acceptance when a retained member writes a new draft', () => {
    fixture(); result('DONE'); mail.settle('a-test'); const first = ref(); accept(parent, 'advisor', first);
    store.updateRun('a-test', current => ({ ...current, state: 'running' })); // advisory resume can become a repair
    result('IN PROGRESS: repair');
    assert.equal(mail.reopen(store.readRun('a-test')!).state, 'running');
    assert.equal(store.readRun('a-test')!.assignment!.status, 'active');
    assert.equal(store.readRun('a-test')!.assignment!.accepted, undefined);
    result('DONE'); mail.settle('a-test'); assert.notEqual(ref(), first);
  });

  it('keeps routing quality separate and restores idle after an advisory turn with unchanged submission', async () => {
    fixture(); result('DONE'); mail.settle('a-test'); const first = ref();
    const { grade } = await import('../src/outcome.ts');
    writeFileSync(process.env.CREW_CONFIG!, JSON.stringify({ router: { command: join(dir, 'absent-router') } }));
    grade(parent, 'advisor', true, 'quality only');
    assert.equal(store.readRun('a-test')!.assignment!.status, 'submitted');
    accept(parent, 'advisor', first);
    store.updateRun('a-test', current => ({ ...current, state: 'running' }));
    mail.settle('a-test', true);
    assert.equal(store.readRun('a-test')!.state, 'idle');
    assert.equal(store.readRun('a-test')!.assignment!.accepted!.submission, first);
    assert.equal(store.readRun('a-test')!.assignment!.submissions.length, 1);
  });

  it('rejects acceptance after packet or immutable snapshot tampering', () => {
    fixture(); result('DONE'); mail.settle('a-test'); const first = ref();
    writeFileSync(store.packetPath('a-test'), 'changed packet without metadata');
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
    writeFileSync(store.packetPath('a-test'), 'initial packet\n');
    writeFileSync(store.readRun('a-test')!.assignment!.submissions[0]!.result, '# Status\nDONE: changed evidence\n');
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
  });

  it('preserves blocked/failed attention for retained members', () => {
    fixture(); result('BLOCKED: decision'); mail.settle('a-test');
    assert.equal(store.readRun('a-test')!.state, 'blocked');
    assert.throws(() => accept(parent, 'advisor', ref()), /blocked\/failed/);
    result('FAIL: incomplete'); mail.settle('a-test'); assert.equal(store.readRun('a-test')!.state, 'failed');
  });

  it('adopts pre-assignment legacy kept settlement metadata without inventing new work', () => {
    fixture(); result('DONE: legacy');
    const hash = readResult(store.resultPath('a-test'))!.hash;
    store.updateRun('a-test', run => ({ ...run, settled: { hash, at: run.createdAt, status: 'DONE: legacy', notified: true } }));
    mail.settle('a-test'); const current = store.readRun('a-test')!;
    assert.equal(current.state, 'idle'); assert.equal(current.assignment!.id, 'initial');
    assert.equal(current.assignmentHistory, undefined); accept(parent, 'advisor', ref());
  });

  it('keeps idle retained names reserved and visible after 24 hours', async () => {
    fixture({ createdAt: '2000-01-01T00:00:00.000Z' }); result('DONE'); mail.settle('a-test');
    assert.equal(JSON.parse(cli(['ls', '--json']))[0].id, 'a-test');
    const { spawn } = await import('../src/spawn.ts');
    await assert.rejects(spawn({ role: 'advisor', name: 'advisor', task: 'x', cwd: dir, keep: true, dryRun: true }), /already named/);
    assert.equal(store.findRun('advisor')!.id, 'a-test');
  });

  it('waits for real descendant settlement and retirement stops the full retained tree', () => {
    fixture(); fixture({ id: 'b-child', name: 'child', parent: { mailbox: 'a-test', host: 'codex' }, keep: false });
    fixture({ id: 'b-grandchild', name: 'grandchild', parent: { mailbox: 'b-child', host: 'codex' }, keep: false });
    result('DONE: parent'); assert.equal(mail.settle('a-test'), undefined);
    assert.equal(activeDescendants('a-test').length, 2);
    assert.match(runHook('stop', 'codex', '{"session_id":"root"}', process.env), /work remains active/);
    result('DONE: grandchild', 'b-grandchild'); mail.settle('b-grandchild');
    result('DONE: child', 'b-child'); mail.settle('b-child'); mail.settle('a-test');
    assert.equal(store.readRun('a-test')!.state, 'idle');
    cli(['stop', 'advisor']); assert.ok(store.listRuns().every(r => r.state === 'stopped'));
    assert.throws(() => mail.assign(parent, 'advisor', 'new work'), /retained member/);
  });

  it('recovers late outboxes after replacement and explicit retirement without replaying inbox mail', async () => {
    const legacy = fixture(); result('DONE: committed'); mail.settle('a-test');
    const settled = store.readRun('a-test')!.settled!;
    const event = join(store.runDir('a-test'), `.settled-${settled.ref}`);
    rmSync(store.mailDir(parent.mailbox), { recursive: true, force: true });
    store.writeJson(event, { ...settled, notified: false });
    store.writeRun({ ...legacy, state: 'stopped' });
    result('IN PROGRESS: later draft');
    await watch(parent.mailbox, 5, 40);
    const notices = mail.takeUnread(parent.mailbox);
    assert.equal(notices.length, 1); assert.equal(notices[0]!.result, settled.notice!.result);
    assert.match(readFileSync(notices[0]!.result!, 'utf8'), /DONE: committed/);
    assert.equal(mail.settle('a-test'), undefined); assert.equal(mail.takeUnread(parent.mailbox).length, 0);
  });

  it('recovers interrupted packet changes before acceptance and preserves prior assignment evidence', () => {
    fixture(); result('DONE: first'); mail.settle('a-test'); const first = ref(); accept(parent, 'advisor', first);
    const previous = store.readRun('a-test')!.assignment!;
    const next = { id: 'task-crash', revision: 0, createdAt: '2026-10-11', status: 'active', submissions: [] };
    const notice = { id: 'assignment-crash', at: '2026-10-11', kind: 'assignment', from: parent, text: 'next outcome' };
    store.writeJson(join(store.runDir('a-test'), 'packet-change.json'), {
      assignment: next, assignmentHistory: [previous], packet: 'next packet\n', draft: '# Status\nIN PROGRESS: recovered assignment\n', notice,
    });
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
    assert.equal(store.readRun('a-test')!.assignment!.id, 'task-crash');
    assert.equal(store.readRun('a-test')!.assignmentHistory![0]!.accepted!.submission, first);
    assert.match(readFileSync(store.packetPath('a-test'), 'utf8'), /next packet/);
    assert.equal(mail.takeUnread('a-test').length, 1);
    // Replaying an intent after inbox consumption still does not duplicate the mail.
    store.writeJson(join(store.runDir('a-test'), 'packet-change.json'), {
      assignment: next, assignmentHistory: [previous], packet: 'next packet\n', draft: '# Status\nIN PROGRESS: recovered assignment\n', notice,
    });
    store.updateRun('a-test', () => undefined);
    assert.equal(mail.takeUnread('a-test').length, 0);
    result('DONE: recovered outcome'); mail.settle('a-test'); accept(parent, 'advisor', ref());
  });

  it('serializes concurrent submissions, exact acceptance and amendment', async () => {
    fixture(); result('DONE: race');
    const script = "import {settle} from './src/mail.ts'; settle('a-test');";
    await Promise.all([exec(process.execPath, ['--input-type=module', '-e', script], { env: process.env }), exec(process.execPath, ['--input-type=module', '-e', script], { env: process.env })]);
    const first = ref(); assert.equal(mail.takeUnread(parent.mailbox).length, 1);
    const receipts = await Promise.all([exec(CLI, ['accept', 'advisor', first], { env: process.env }), exec(CLI, ['accept', 'advisor', first], { env: process.env })]);
    assert.ok(receipts.every(r => r.stdout.includes(first))); assert.equal(store.readRun('a-test')!.assignment!.status, 'accepted');
    await Promise.allSettled([exec(CLI, ['accept', 'advisor', first], { env: process.env }), exec(CLI, ['amend', 'advisor', 'revision after race'], { env: process.env })]);
    assert.equal(store.readRun('a-test')!.assignment!.accepted, undefined);
    assert.throws(() => accept(parent, 'advisor', first), /stale/);
  });

  it('ignores legacy capacity settings without mutating config', () => {
    const config = JSON.stringify({ capacity: { claude: { max: 0, overflow: 'invalid' } } });
    writeFileSync(process.env.CREW_CONFIG!, config);
    assert.equal('capacity' in store.loadConfig(), false);
    assert.equal(readFileSync(process.env.CREW_CONFIG!, 'utf8'), config);
  });
});

