import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
