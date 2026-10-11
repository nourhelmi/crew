import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setupIsolatedHookTrust } from '../evals/hook-trust.ts';
import { isolatedEnv } from '../evals/live.ts';

const vettedHooksFile = resolve('codex/hooks.json');
function sandbox(mutation = '', after = false, hang = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crew-hook-trust-test-'))), workspace = join(base, 'workspace');
  const env = isolatedEnv(base);
  for (const dir of [workspace, env.HOME!, env.CODEX_HOME!]) mkdirSync(dir);
  writeFileSync(join(base, 'codex/hooks.json'), readFileSync(vettedHooksFile));
  const codexBin = join(base, 'fake-codex.cjs');
  writeFileSync(codexBin, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
fs.writeFileSync(path.join(process.env.HOME,'pid'),String(process.pid));
let trusted=false;const input=rl.createInterface({input:process.stdin});
${hang ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : ''}
input.on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(path.join(process.env.HOME,'rpc.jsonl'),line+'\\n');if(!m.id)return;
 const send=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 if(m.method==='initialize'){send({});return;}
 if(m.method==='hooks/list'){
  ${hang ? 'return;' : ''}
  const sourcePath=path.join(process.env.CODEX_HOME,'hooks.json'),groups=JSON.parse(fs.readFileSync(sourcePath,'utf8')).hooks;
  let hooks=Object.entries(groups).flatMap(([event,entries])=>entries.flatMap(group=>group.hooks.map((hook,index)=>({key:event+'-'+index,eventName:event[0].toLowerCase()+event.slice(1),handlerType:hook.type,command:hook.command,matcher:group.matcher??null,timeoutSec:hook.timeout,async:hook.async??false,sourcePath,source:'user',pluginId:null,isManaged:false,currentHash:'hash-'+event,enabled:trusted,trustStatus:trusted?'trusted':'untrusted'}))));
  if(trusted===${after}){${mutation}}
  send({data:[{cwd:process.cwd(),hooks,warnings:[],errors:[]}]});return;
 }
 if(m.method==='config/batchWrite'){
  if(m.params.filePath!==path.join(process.env.CODEX_HOME,'config.toml'))process.exit(9);
  fs.writeFileSync(m.params.filePath,JSON.stringify(m.params.edits[0].value));trusted=true;send({});return;
 }
 process.exit(8);
});
`, { mode: 0o700 });
  return { base, workspace, env, codexBin, vettedHooksFile };
}
function calls(base: string): { method: string; params: any }[] {
  return readFileSync(join(base, 'home/rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function dead(base: string): void {
  const path = join(base, 'home/pid');
  if (existsSync(path)) assert.throws(() => process.kill(Number(readFileSync(path, 'utf8')), 0), /ESRCH/);
}

describe('isolated vetted Crew hook trust setup', () => {
  it('writes only reviewed hooks.state to explicit isolated config and requires trusted enabled reload', async () => {
    const options = sandbox();
    options.workspace = join(options.base, 'cos-project'); mkdirSync(options.workspace);
    try {
      const evidence = await setupIsolatedHookTrust(options);
      assert.equal(evidence.before.length, 5); assert.equal(evidence.after.length, 5);
      assert.ok(evidence.after.every(hook => hook.enabled && hook.trustStatus === 'trusted'));
      assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
      const rpc = calls(options.base);
      assert.deepEqual(rpc.map(call => call.method), ['initialize', 'initialized', 'hooks/list', 'config/batchWrite', 'hooks/list']);
      assert.deepEqual(rpc[2]!.params, { cwds: [options.workspace] });
      assert.deepEqual(rpc[3]!.params, { filePath: join(options.base, 'codex/config.toml'), edits: [{ keyPath: 'hooks.state',
        value: Object.fromEntries(evidence.before.map(hook => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: 'upsert' }], reloadUserConfig: true });
      assert.ok(rpc.every(call => !call.method.startsWith('thread/') && !call.method.startsWith('turn/')));
      dead(options.base);
    } finally { rmSync(options.base, { recursive: true, force: true }); }
  });
  const mutations: [string, string][] = [
    ['foreign source path', "hooks[0].sourcePath='/personal/hooks.json';"],
    ['changed command', "hooks[0].command='arbitrary command';"],
    ['changed event', "hooks[0].eventName='preToolUse';"],
    ['changed matcher', "hooks[0].matcher='.*';"],
    ['changed timeout', 'hooks[0].timeoutSec=999;'],
    ['changed async', 'hooks[0].async=true;'],
    ['different handler', "hooks[0].handlerType='prompt';"],
    ['managed/plugin source', "hooks[0].source='plugin';hooks[0].pluginId='foreign';"],
    ['missing hash', "hooks[0].currentHash='';"],
    ['duplicate key', 'hooks[1].key=hooks[0].key;'],
    ['missing hook', 'hooks.pop();'],
    ['additional arbitrary hook', 'hooks.push({...hooks[0],key:"foreign"});'],
  ];
  for (const [name, mutation] of mutations) it(`rejects ${name} before any trust write`, async () => {
    const options = sandbox(mutation);
    try {
      await assert.rejects(setupIsolatedHookTrust(options), /Hook (metadata|list)/);
      assert.ok(!calls(options.base).some(call => call.method === 'config/batchWrite'));
      assert.equal(existsSync(join(options.base, 'codex/config.toml')), false); dead(options.base);
    } finally { rmSync(options.base, { recursive: true, force: true }); }
  });
  for (const [name, mutation] of [
    ['disabled', 'hooks[0].enabled=false;'], ['untrusted', "hooks[0].trustStatus='untrusted';"],
    ['changed hash', "hooks[0].currentHash='different-hash';"], ['changed key', "hooks[0].key='different-key';"],
    ['changed command', "hooks[0].command='changed after trust';"],
  ]) it(`rejects ${name} after reload`, async () => {
    const options = sandbox(mutation, true);
    try { await assert.rejects(setupIsolatedHookTrust(options), /Hook metadata|not enabled\/trusted/); dead(options.base); }
    finally { rmSync(options.base, { recursive: true, force: true }); }
  });
  it('refuses unvetted/copied bytes, symlink config and a personal home before spawning', async () => {
    const options = sandbox();
    try {
      await assert.rejects(setupIsolatedHookTrust({ ...options, vettedHooksFile: join(options.base, 'codex/hooks.json') }), /explicitly vetted/);
      await assert.rejects(setupIsolatedHookTrust({ ...options, env: { ...options.env, CODEX_HOME: '/personal' } }), /isolated/);
      const copy = join(options.base, 'codex/hooks.json'); writeFileSync(copy, '{}');
      await assert.rejects(setupIsolatedHookTrust(options), /exact copy/);
      writeFileSync(copy, readFileSync(vettedHooksFile));
      const foreign = join(options.base, 'foreign.toml'); writeFileSync(foreign, 'unchanged');
      symlinkSync(foreign, join(options.base, 'codex/config.toml'));
      await assert.rejects(setupIsolatedHookTrust(options), /regular isolated/);
      assert.equal(readFileSync(foreign, 'utf8'), 'unchanged'); assert.equal(existsSync(join(options.base, 'home/pid')), false);
    } finally { rmSync(options.base, { recursive: true, force: true }); }
  });
  it('interrupts a hung setup RPC and kills its TERM-resistant owned server without trusting hooks', async () => {
    const options = sandbox('', false, true), controller = new AbortController();
    try {
      const pending = setupIsolatedHookTrust({ ...options, signal: controller.signal });
      const observed = assert.rejects(pending, /interrupted or timed out/);
      while (!existsSync(join(options.base, 'home/rpc.jsonl'))) await delay(10);
      controller.abort(); await observed;
      assert.equal(existsSync(join(options.base, 'codex/config.toml')), false); dead(options.base);
    } finally { rmSync(options.base, { recursive: true, force: true }); }
  });
});
