import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RunMeta } from '../src/types.ts';
import { processExists, recordProcess, terminateOwnedTree } from '../src/console-process.ts';

const testRoot = mkdtempSync(join(tmpdir(), 'crew-exec-process-'));
const bin = join(testRoot, 'bin'); mkdirSync(bin);
Object.assign(process.env, {
  HOME: testRoot, PATH: `${bin}:${process.env.PATH}`, CREW_HOME: join(testRoot, 'crew'),
  CREW_CONFIG: join(testRoot, 'config.json'), CREW_ROSTER: join(testRoot, 'roster.json'),
  CODEX_HOME: join(testRoot, 'codex'), CLAUDE_CONFIG_DIR: join(testRoot, 'claude'),
  ADVISOR_STATE_DIR: join(testRoot, 'advisor'), HERDR_BIN_PATH: join(bin, 'herdr'), CREW_NO_DELEGATE: '1',
});
for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_OPENCODE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID',
  'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID', 'CREW_CODEX_SOCKET', 'CODEX_APP_SERVER_WS_URL']) delete process.env[key];
for (const name of ['herdr', 'claude', 'opencode', 'agent-router']) {
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
}
after(() => rmSync(testRoot, { recursive: true, force: true }));
const store = await import('../src/store.ts');
const { launchExec } = await import('../src/spawn.ts');
const { stopRun } = await import('../src/retire.ts');

test('exec cancellation kills a detached tool shell and its children before they can write after Stop', async () => {
  const marker = join(testRoot, 'should-not-exist');
  const ready = join(testRoot, 'ready.json');
  const wrapper = `const {spawn}=require('node:child_process');
const child=spawn('/bin/sh',['-c', 'trap "" TERM; sleep 2; echo survived > '+${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({child:child.pid}));
setInterval(()=>{},1000);`;
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n${wrapper}`, { mode: 0o755 });
  const unrelated = spawnProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);process.send("ready")'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let run: RunMeta | undefined;
  let toolPid: number | undefined;
  try {
    await once(unrelated, 'message');
    const meta: RunMeta = { id: 'b-tree', name: 'tree', role: 'builder', cwd: testRoot, keep: true,
      parent: { mailbox: 'codex-root', host: 'codex' }, launcher: 'exec', state: 'running',
      route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' }, createdAt: new Date().toISOString() };
    store.writeRun(meta);
    run = { ...meta, ...await launchExec(meta, [], { CREW_HOME: store.home() }) };
    store.writeRun(run);
    assert.equal(run.ownedProcess?.pid, run.pid, 'exec launch records ownership before returning');
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    toolPid = (JSON.parse(readFileSync(ready, 'utf8')) as { child: number }).child;
    const toolGroup = Number(execFileSync('ps', ['-p', String(toolPid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    assert.notEqual(toolGroup, run.pid, 'tool really escaped the wrapper process group');
    const shellChildren = (): number[] => execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' })
      .trim().split('\n').flatMap(line => {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        return parent === toolPid ? [pid!] : [];
      });
    let nested = shellChildren();
    while (!nested.length) {
      assert.ok(Date.now() < deadline, 'the detached shell must have started its sleep child');
      await new Promise(resolve => setTimeout(resolve, 10));
      nested = shellChildren();
    }
    await stopRun(run);
    assert.equal(store.readRun(run.id)?.state, 'stopped');
    assert.equal(processExists(run.pid!), false);
    assert.equal(processExists(toolPid), false);
    assert.ok(nested.every(pid => !processExists(pid)), 'descendants of the escaped shell are also stopped');
    assert.equal(processExists(unrelated.pid!), true, 'unrelated process survives cancellation');
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(existsSync(marker), false, 'the detached shell cannot continue after Stop');
  } finally {
    for (const pid of [run?.pid, toolPid, unrelated.pid]) if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* owned fixture exited */ } }
    if (unrelated.connected) unrelated.disconnect();
  }
});

test('tree cancellation refuses a mismatched launch stamp without stopping an unrelated process', async () => {
  const child = spawnProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);process.send("ready")'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const owned = recordProcess(child.pid!, true);
    await assert.rejects(terminateOwnedTree({ ...owned, fingerprint: 'different-launch' }), /ownership changed/);
    assert.equal(processExists(child.pid!), true);
    const state = execFileSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    assert.ok(!state.includes('T'), 'ownership rejection must not freeze the unrelated process');
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* owned fixture exited */ }
    if (child.connected) child.disconnect();
  }
});

test('a failed tree signal resumes the still-owned frozen worker instead of stranding it', async () => {
  const child = spawnProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);process.send("ready")'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const originalKill = process.kill;
  try {
    await once(child, 'message');
    const owned = recordProcess(child.pid!, true);
    process.kill = ((pid, signal) => {
      if (pid === child.pid && signal === 'SIGKILL') throw Object.assign(new Error('Fixture denied cancellation'), { code: 'EPERM' });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await assert.rejects(terminateOwnedTree(owned), { code: 'EPERM' });
    assert.equal(processExists(child.pid!), true);
    const state = execFileSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    assert.ok(!state.includes('T'), 'failure cleanup must release an owned SIGSTOP');
  } finally {
    process.kill = originalKill;
    try { originalKill(-child.pid!, 'SIGKILL'); } catch { /* owned fixture exited */ }
    if (child.connected) child.disconnect();
  }
});
