import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { RunMeta } from '../src/types.ts';

const testRoot = mkdtempSync(join(tmpdir(), 'crew-stop-boundary-'));
const bin = join(testRoot, 'bin');
mkdirSync(bin);
const calls = join(testRoot, 'herdr-calls.jsonl');
const failClose = join(testRoot, 'fail-close');
const unexpectedHost = join(testRoot, 'unexpected-host');
writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (fs.existsSync(${JSON.stringify(failClose)}) && args.at(-1) === 'pane-failure') process.exit(1);
console.log('{}');
`, { mode: 0o755 });
for (const command of ['codex', 'claude', 'opencode', 'agent-router']) {
  writeFileSync(join(bin, command), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(unexpectedHost)}, process.argv.join(' '));
process.exit(99);
`, { mode: 0o755 });
}
Object.assign(process.env, {
  HOME: testRoot, PATH: `${bin}:${process.env.PATH}`, CREW_HOME: join(testRoot, 'crew'),
  CREW_CONFIG: join(testRoot, 'config.json'), CREW_ROSTER: join(testRoot, 'roster.json'),
  CODEX_HOME: join(testRoot, 'codex'), CLAUDE_CONFIG_DIR: join(testRoot, 'claude'),
  ADVISOR_STATE_DIR: join(testRoot, 'advisor'), CODEX_THREAD_ID: 'root',
  CREW_NO_DELEGATE: '1', CREW_NODE: process.execPath, HERDR_BIN_PATH: join(bin, 'herdr'),
});
for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_OPENCODE_SESSION', 'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID',
  'CREW_CODEX_SOCKET', 'CODEX_APP_SERVER_WS_URL', 'CREW_ROUTER']) delete process.env[key];

const store = await import('../src/store.ts');
const { spawn } = await import('../src/spawn.ts');
const { assertSpawnBoundary, rootSpawnBoundary, stopRootChildren } = await import('../src/stop-boundary.ts');
const cli = resolve('bin/crew');
const fixture = (id: string, parent = 'codex-root', overrides: Partial<RunMeta> = {}): RunMeta => {
  const run: RunMeta = {
    id, name: id, role: 'builder', keep: true, cwd: testRoot,
    parent: { mailbox: parent, host: 'codex' },
    route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' },
    launcher: 'herdr', herdr: { pane: `pane-${id}`, agent: id, session: 'isolated-session' },
    createdAt: new Date().toISOString(), state: 'running', ...overrides,
  };
  store.writeRun(run);
  return run;
};
const closeCalls = (): string[][] => existsSync(calls)
  ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];

beforeEach(() => {
  for (const path of [store.home(), calls, failClose, unexpectedHost]) rmSync(path, { recursive: true, force: true });
  delete process.env.CREW_RUN;
});
after(() => rmSync(testRoot, { recursive: true, force: true }));

describe('native root stop boundary', () => {
  it('cancels a spawn awaiting routing before it can reserve metadata or launch a host', async () => {
    const pending = spawn({ role: 'builder', task: 'fixture', cwd: testRoot, keep: true, model: 'codex/fixture' });
    const rejected = assert.rejects(pending, /parent was stopped while this spawn was routing/);
    // Even a pinned route yields once: stop advances the epoch before reservation resumes.
    await stopRootChildren('codex-root');
    await rejected;
    assert.deepEqual(store.listRuns(), []);
    assert.equal(existsSync(unexpectedHost), false);
    assert.deepEqual(closeCalls(), []);
  });

  it('uses the root boundary for a pending nested spawn', async () => {
    fixture('a-advisor');
    process.env.CREW_RUN = 'a-advisor';
    const pending = spawn({ role: 'builder', task: 'nested fixture', cwd: testRoot, keep: true, model: 'codex/fixture' });
    const rejected = assert.rejects(pending, /parent was stopped while this spawn was routing/);
    await stopRootChildren('codex-root');
    await rejected;
    assert.equal(store.listRuns().length, 1);
    assert.equal(store.readRun('a-advisor')?.state, 'stopped');
    assert.equal(existsSync(unexpectedHost), false);
  });

  it('CLI stops a whole tree using recorded sessions and leaves another root untouched', () => {
    fixture('a-advisor');
    fixture('b-child', 'a-advisor');
    fixture('c-grandchild', 'b-child');
    fixture('b-peer', 'codex-peer');
    const peerBoundary = rootSpawnBoundary('codex-peer');
    const output = execFileSync(cli, ['stop', '--children-of', 'codex-root'], { env: process.env, encoding: 'utf8' });
    assert.match(output, /stopped children of codex-root/);
    for (const id of ['a-advisor', 'b-child', 'c-grandchild']) assert.equal(store.readRun(id)?.state, 'stopped');
    assert.equal(store.readRun('b-peer')?.state, 'running');
    assert.doesNotThrow(() => assertSpawnBoundary(peerBoundary));
    assert.deepEqual(closeCalls().map(args => args.at(-1)).sort(), ['pane-a-advisor', 'pane-b-child', 'pane-c-grandchild']);
    assert.ok(closeCalls().every(args => args.slice(0, 4).join(' ') === '--session isolated-session pane close'));
    assert.equal(existsSync(unexpectedHost), false);
  });

  it('permits fresh work after stop but rejects the previous generation', async () => {
    const previous = rootSpawnBoundary('codex-root');
    await stopRootChildren('codex-root');
    assert.throws(() => assertSpawnBoundary(previous), /launch cancelled/);
    const next = rootSpawnBoundary('codex-root');
    assert.notEqual(next.epoch, previous.epoch);
    assert.doesNotThrow(() => assertSpawnBoundary(next));
    assert.equal(existsSync(join(store.mailDir('codex-root'), 'console-retired.json')), false);
    await stopRootChildren('codex-root');
    assert.throws(() => assertSpawnBoundary(next), /launch cancelled/);
    assert.doesNotThrow(() => assertSpawnBoundary(rootSpawnBoundary('codex-root')));
  });

  it('reports failed closes, still stops other children, and retries failed ownership on the next stop', async () => {
    fixture('failure');
    fixture('sibling');
    writeFileSync(failClose, 'fail');
    await assert.rejects(stopRootChildren('codex-root'), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /retry stop/);
      assert.match(String(error.errors[0]), /pane close failed/);
      return true;
    });
    assert.equal(store.readRun('failure')?.state, 'stopped');
    assert.equal(store.readRun('failure')?.herdr?.closed, undefined);
    assert.equal(store.readRun('sibling')?.herdr?.closed, true);
    rmSync(failClose);
    await stopRootChildren('codex-root');
    assert.equal(store.readRun('failure')?.herdr?.closed, true);
    assert.equal(closeCalls().filter(args => args.at(-1) === 'pane-failure').length, 2);
    assert.equal(closeCalls().filter(args => args.at(-1) === 'pane-sibling').length, 1);
  });

  it('rejects invalid mailboxes and ambiguous CLI targets without altering runs', async () => {
    fixture('b-kept');
    for (const mailbox of ['b-kept', 'codex-', 'codex-../../escape', 'codex-root/child', `codex-${'x'.repeat(161)}`]) {
      await assert.rejects(stopRootChildren(mailbox), /native host session mailbox/);
    }
    const invalid = spawnSync(cli, ['stop', '--children-of', 'codex-../escape'], { env: process.env, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /native host session mailbox/);
    const ambiguous = spawnSync(cli, ['stop', 'b-kept', '--children-of', 'codex-root'], { env: process.env, encoding: 'utf8' });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /choose a run or --children-of/);
    assert.equal(store.readRun('b-kept')?.state, 'running');
    assert.deepEqual(closeCalls(), []);
    assert.equal(rootSpawnBoundary('codex-root').epoch, null);
  });
});
