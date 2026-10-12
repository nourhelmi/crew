import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordProcess, processExists, terminateOwnedProcess } from '../src/console-process.ts';

for (const verified of [true, false]) test(verified ? 'recovery cannot overlook a native host surviving its recorded wrapper' : 'unverified surviving group blocks resume without signaling its processes', async () => {
  const dir = mkdtempSync('/private/tmp/crew-console-review-process-');
  const wrapper = join(dir, 'wrapper.cjs');
  writeFileSync(wrapper, `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['--eval',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'native.pid'))},String(child.pid));process.send('ready')});
setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [wrapper], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const nativePid = Number(readFileSync(join(dir, 'native.pid'), 'utf8'));
    const handle = recordProcess(child.pid!, true);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(processExists(handle.pid), false);
    assert.equal(processExists(nativePid), true);
    if (verified) {
      await assert.rejects(terminateOwnedProcess({ ...handle, group: false }), /lacks an owned process group/);
      assert.equal(processExists(nativePid), true, 'legacy leader-only proof cannot authorize recovery');
      await terminateOwnedProcess(handle);
      assert.equal(processExists(nativePid), false, 'recorded wrapper death must not hide its native host');
    } else {
      delete handle.members;
      await assert.rejects(terminateOwnedProcess(handle), /unverified live process group/);
      assert.equal(processExists(nativePid), true, 'unverified group must not receive a recovery signal');
    }
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* owned group gone */ }
    if (child.connected) child.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retirement handles a group becoming zombie-only between ownership verification and signaling', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync('/private/tmp/crew-console-review-zombie-');
  const wrapper = join(dir, 'wrapper.cjs');
  writeFileSync(wrapper, `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['--eval',"setInterval(()=>{},1000);process.send('ready')"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>process.send(child.pid));setInterval(()=>{},1000);`);
  const parent = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const originalKill = process.kill;
  let pid: number | undefined;
  try {
    [pid] = await once(parent, 'message') as [number];
    const handle = recordProcess(pid, true);
    originalKill(parent.pid!, 'SIGSTOP'); // Keep the exited child unreaped at the race boundary.
    let raced = false;
    process.kill = ((target, signal) => {
      if (target === -pid! && signal === 'SIGTERM' && !raced) {
        raced = true;
        originalKill(pid!, 'SIGKILL');
        const deadline = Date.now() + 2000;
        while (!execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z')) {
          assert.ok(Date.now() < deadline, 'Owned child must enter the zombie state');
        }
      }
      return originalKill(target, signal);
    }) as typeof process.kill;
    await terminateOwnedProcess(handle);
    assert.equal(raced, true);
    assert.equal(processExists(pid), false);
  } finally {
    process.kill = originalKill;
    if (pid) { try { originalKill(-pid, 'SIGKILL'); } catch { /* only an owned zombie may remain */ } }
    try { originalKill(parent.pid!, 'SIGCONT'); } catch { /* already exited */ }
    if (parent.exitCode === null && parent.signalCode === null) { const exited=once(parent,'exit');parent.kill('SIGTERM');await exited; }
    if(parent.connected)parent.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retirement still rejects EPERM while an owned group has live members', async () => {
  const child=spawn(process.execPath,['--eval',"setInterval(()=>{},1000);process.send('ready')"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  const originalKill=process.kill;
  try {
    await once(child,'message');
    const handle=recordProcess(child.pid!,true);
    process.kill=((pid,signal)=>{
      if(pid===-child.pid! && signal==='SIGTERM')throw Object.assign(new Error('Denied live signal'),{code:'EPERM'});
      return originalKill(pid,signal);
    }) as typeof process.kill;
    await assert.rejects(terminateOwnedProcess(handle),{code:'EPERM'});
    assert.equal(processExists(child.pid!),true);
  } finally {
    process.kill=originalKill;
    const exited=once(child,'exit');
    try { originalKill(-child.pid!,'SIGKILL'); } catch { /* owned group already exited */ }
    await exited;
    if(child.connected)child.disconnect();
  }
});
