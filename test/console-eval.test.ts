import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { scoreConsoleCapture } from '../evals/console-capture.ts';
import { consoleCounterexamples, consoleFixture } from '../evals/console-fixtures.ts';
import { runConsoleLive } from '../evals/console-live.ts';
import { isolatedEnv, recorderShim, signalOwned } from '../evals/live.ts';
import { consoleAssertions, scenarios } from '../evals/scenarios.ts';
import { score } from '../evals/score.ts';

describe('console eval scorer proof boundaries', () => {
  it('scores normalized console events with HTTP, SSE, identity, verifier and fresh nonce evidence', () => {
    const report = scoreConsoleCapture(consoleFixture(), 'synthetic-only', 100);
    assert.equal(report.status, 'pass'); assert.equal(report.surface, 'console-api');
    assert.ok(report.cases.slice(1).every(c => c.status === 'not-executed'));
    assert.equal(report.cases[0]!.assertions.length, scenarios[1].assertions.length + consoleAssertions.length);
    assert.match(report.note, /API proof; browser/);
  });
  for (const example of consoleCounterexamples) it(`rejects ${example.name}`, () => {
    const capture = structuredClone(consoleFixture()); example.mutate(capture);
    const report = scoreConsoleCapture(capture, 'synthetic-only', 0);
    assert.equal(report.status, 'fail');
    assert.equal(report.cases[0]!.assertions.find(a => a.id === example.assertion)?.status, 'fail');
  });
  it('does not upgrade missing console observations to a CLI tiny-repair pass', () => {
    const result = score({ case: 'advisor-tiny-repair', surface: 'console-api', launchCount: 0, facts: {} });
    assert.equal(result.status, 'not-executed');
    assert.ok(result.assertions.every(a => a.status === 'not-executed'));
  });
});

function fakeProvider(dir: string, mode: 'pass' | 'hang' | 'wrong-artifact' = 'pass'): string {
  const host = join(dir, 'fake-codex');
  writeFileSync(host, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),rl=require('node:readline');
const argv=process.argv.slice(2);
if(argv[0]==='login')process.exit(0);
if(argv[0]==='--version'){console.log('codex synthetic-only');process.exit(0);}
if(!argv.includes('app-server')||argv.at(-1)!=='stdio://')process.exit(8);
if((fs.statSync(path.join(process.env.CODEX_HOME,'auth.json')).mode&0o777)!==0o600)process.exit(9);
const thread='synthetic-provider-thread',mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(join(dir, 'server-pids.jsonl'))},String(process.pid)+'\\n');
const log=value=>fs.appendFileSync(${JSON.stringify(join(dir, 'provider.jsonl'))},JSON.stringify(value)+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params});
let count=0,trusted=false;
process.on('SIGTERM',()=>{if(mode!=='hang')process.exit(0);});
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;log({method:m.method,params:m.params});
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'synthetic-only'}});return;}
 if(m.method==='hooks/list'){
  const sourcePath=path.join(process.env.CODEX_HOME,'hooks.json');const groups=JSON.parse(fs.readFileSync(sourcePath,'utf8')).hooks;
  const hooks=Object.entries(groups).flatMap(([event,entries])=>entries.flatMap(group=>group.hooks.map((hook,index)=>({key:event+'-'+index,eventName:event[0].toLowerCase()+event.slice(1),handlerType:hook.type,command:hook.command,matcher:group.matcher??null,timeoutSec:hook.timeout,async:hook.async??false,sourcePath,source:'user',pluginId:null,isManaged:false,currentHash:'synthetic-hash-'+event,enabled:trusted,trustStatus:trusted?'trusted':'untrusted'}))));
  send({id:m.id,result:{data:[{cwd:process.cwd(),hooks,errors:[],warnings:[]}]}});return;
 }
 if(m.method==='config/batchWrite'){fs.writeFileSync(m.params.filePath,JSON.stringify(m.params.edits[0].value));trusted=true;send({id:m.id,result:{}});return;}
 if(m.method==='config/read'){send({id:m.id,result:{config:{sandbox_workspace_write:{writable_roots:[process.env.EVAL_BASE],network_access:true}}}});return;}
 if(m.method==='thread/start'||m.method==='thread/resume'){
  fs.writeFileSync(${JSON.stringify(join(dir, 'locator.json'))},JSON.stringify({home:process.env.HOME,codexHome:process.env.CODEX_HOME,base:process.env.EVAL_BASE,pid:process.pid}));
  send({id:m.id,result:{thread:{id:thread,turns:[],status:{type:'idle'}}}});return;
 }
 if(m.method==='turn/start'){
  const turnId='turn-'+(++count);send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
  notify('turn/started',{threadId:thread,turn:{id:turnId,status:'inProgress'}});
  if(mode==='hang')return;
  setTimeout(()=>{
   const command=count===1?'node verify.mjs':'write followup.json';
   notify('item/started',{threadId:thread,turnId,item:{id:'tool-'+count,type:'commandExecution',command,status:'inProgress'}});
   if(count===1){fs.writeFileSync('greeting.json',JSON.stringify({message:'Hello world',unchanged:'preserve-me'}));
    cp.execFileSync('node',['verify.mjs'],{env:{...process.env,CODEX_THREAD_ID:thread},cwd:process.cwd()});
   }else{const text=m.params.input[0].text;const nonce=text.match(/[a-f0-9]{48}/)[0];fs.writeFileSync('followup.json',JSON.stringify({nonce:mode==='wrong-artifact'?'stale':nonce,message:'Hello world'}));}
   notify('item/completed',{threadId:thread,turnId,item:{id:'tool-'+count,type:'commandExecution',command,status:'completed',exitCode:0,aggregatedOutput:'synthetic tool output'}});
   notify('item/completed',{threadId:thread,turnId,item:{id:'assistant-'+count,type:'agentMessage',text:'synthetic-secret-token: completed',phase:'final_answer'}});
   notify('turn/completed',{threadId:thread,turn:{id:turnId,status:'completed'}});
  },30);return;
 }
 send({id:m.id,error:{code:-32601,message:'unsupported synthetic method'}});
});
`, { mode: 0o700 });
  return host;
}

describe('actual console HTTP runner with a credential-free fake provider', () => {
  it('launches once, delivers two inputs, reconnects SSE, binds verifier bytes, sanitizes and cleans up', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-e2e-test-')));
    try {
      const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-secret-token"}}');
      const host = fakeProvider(dir);
      const { report, directory } = await runConsoleLive({ model: 'synthetic', timeoutMs: 12_000, out: join(dir, 'reports'), authFile: auth, codexBin: host });
      assert.equal(report.status, 'pass', JSON.stringify(report));
      const methods = readFileSync(join(dir, 'provider.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
      assert.equal(methods.filter(m => m === 'thread/start').length, 1);
      assert.equal(methods.filter(m => m === 'turn/start').length, 2);
      const capture = JSON.parse(readFileSync(join(directory, 'console-capture.json'), 'utf8'));
      assert.equal(capture.streams.some((s: { connection: number }) => s.connection === 1), true);
      assert.equal(capture.streams.some((s: { connection: number }) => s.connection === 2), true);
      assert.ok(capture.receipts.some((r: { args: string[] }) => r.args.includes('app-server')));
      const trust = JSON.parse(readFileSync(join(directory, 'hooks-trust.json'), 'utf8'));
      assert.equal(trust.after.length, 5);
      assert.ok(trust.after.every((h: { enabled: boolean; trustStatus: string }) => h.enabled && h.trustStatus === 'trusted'));
      const inspect = (path: string): void => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) inspect(file);
          else { assert.ok(!readFileSync(file, 'utf8').includes('synthetic-secret-token'), file); assert.equal(statSync(file).mode & 0o777, 0o600, file); }
        }
      };
      inspect(directory);
      const { home, codexHome, base, pid } = JSON.parse(readFileSync(join(dir, 'locator.json'), 'utf8'));
      for (const path of [home, codexHome, base]) assert.equal(existsSync(path), false, path);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      for (const serverPid of readFileSync(join(dir, 'server-pids.jsonl'), 'utf8').trim().split('\n').map(Number)) {
        assert.throws(() => process.kill(serverPid, 0), /ESRCH/);
      }
      const cleanup = JSON.parse(readFileSync(join(directory, 'cleanup.json'), 'utf8'));
      assert.equal(cleanup.closeReceipt.command.state, 'delivered');
      for (const pid of [cleanup.serverPid, ...cleanup.supervisorGroups]) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails a started provider that echoes the nonce without producing the correct artifact', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-e2e-test-')));
    try {
      const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-secret-token"}}');
      const { report } = await runConsoleLive({ model: 'synthetic', timeoutMs: 12_000, out: join(dir, 'reports'), authFile: auth, codexBin: fakeProvider(dir, 'wrong-artifact') });
      assert.equal(report.status, 'fail');
      assert.equal(report.cases[0]!.assertions.find(a => a.id === 'nonce-artifact')?.status, 'fail');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('cleans up the owned provider and copied auth on timeout and interruption', async () => {
    for (const interrupt of [false, true]) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-e2e-test-')));
      try {
        const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-secret-token"}}');
        const started = Date.now();
        const pending = runConsoleLive({ model: 'synthetic', timeoutMs: interrupt ? 15_000 : 3000, out: join(dir, 'reports'), authFile: auth, codexBin: fakeProvider(dir, 'hang') });
        if (interrupt) {
          while (!existsSync(join(dir, 'locator.json')) && Date.now() - started < 8000) await delay(20);
          assert.ok(existsSync(join(dir, 'locator.json')), 'owned fake app-server must start before interruption');
          process.emit('SIGINT');
        }
        const { report } = await pending;
        assert.equal(report.status, 'fail', JSON.stringify(report)); assert.match(report.note, interrupt ? /Interrupted/ : /Timed out/);
        if (interrupt) assert.ok(Date.now() - started < 10_000, 'signal cleanup does not wait for workflow deadline');
        const { home, pid } = JSON.parse(readFileSync(join(dir, 'locator.json'), 'utf8'));
        assert.equal(existsSync(home), false); assert.throws(() => process.kill(pid, 0), /ESRCH/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

describe('console live opt-in and isolated recorder', () => {
  it('rejects an unrelated recorded PID even when its path has the sandbox prefix', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-ownership-test-')));
    const sibling = `${base}-unrelated`; mkdirSync(sibling);
    const script = join(sibling, 'host.cjs'); writeFileSync(script, 'setInterval(()=>{},1000);');
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      signalOwned(base, child.pid, 'SIGTERM', [child.pid!]); await delay(50);
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
      rmSync(base, { recursive: true, force: true }); rmSync(sibling, { recursive: true, force: true });
    }
  });
  it('blocks missing auth and rejects symlink auth before launching a host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-console-eval-test-'));
    try {
      const options = { model: 'synthetic', timeoutMs: 100, out: dir, codexBin: '/unused' };
      const missing = await runConsoleLive(options);
      assert.equal(missing.report.status, 'blocked'); assert.equal(missing.report.surface, 'console-api');
      assert.match(missing.report.note, /Missing explicit/);
      assert.ok(missing.report.cases.filter(c => c.case !== 'advisor-tiny-repair').every(c => c.status === 'not-executed'));
      const auth = join(dir, 'synthetic-auth.json'); writeFileSync(auth, '{"token":"synthetic-only"}');
      symlinkSync(auth, join(dir, 'link.json'));
      const linked = await runConsoleLive({ ...options, authFile: join(dir, 'link.json') });
      assert.equal(linked.report.status, 'blocked'); assert.match(linked.report.note, /not a symlink/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps CLI recorder app-server disabled and confines console allowance to owned stdio', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-shim-test-')));
    try {
      const bin = join(base, 'bin'); const workspace = join(base, 'workspace'); mkdirSync(bin); mkdirSync(workspace);
      const target = join(base, 'fake-codex'); const marker = join(base, 'invoked');
      writeFileSync(target, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'synthetic');`, { mode: 0o700 });
      const env = { ...isolatedEnv(base), EVAL_BASE: base, EVAL_CODEX: target, EVAL_CONSOLE: '1' };
      const shim = join(bin, 'codex');
      const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(shim, args, { cwd: workspace, env: { ...env, ...overrides }, encoding: 'utf8' });
      writeFileSync(shim, recorderShim(), { mode: 0o700 });
      assert.equal(run(['app-server', '--listen', 'stdio://']).status, 127);
      writeFileSync(shim, recorderShim(true), { mode: 0o700 });
      assert.equal(run(['-c', 'approval_policy="never"', 'app-server', '--listen', 'stdio://']).status, 0);
      assert.equal(readFileSync(marker, 'utf8'), 'synthetic'); rmSync(marker);
      for (const args of [
        ['app-server', '--listen', 'unix:///personal.sock'],
        ['app-server', '--listen', 'unix:///personal.sock', 'stdio://'],
        ['app-server', '--listen', 'stdio://', '--listen', 'unix:///personal.sock'],
        ['app-server', 'generate-ts'], ['app-server', '--listen', 'ws://localhost:4318'],
      ]) assert.equal(run(args).status, 127);
      assert.equal(run(['app-server', '--listen', 'stdio://'], { CODEX_HOME: '/personal-codex' }).status, 127);
      assert.equal(run(['app-server', '--listen', 'stdio://'], { EVAL_CONSOLE: undefined }).status, 127);
      assert.throws(() => readFileSync(marker), /ENOENT/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('does not accept surface/provider flags in the credential-free fixture command', () => {
    assert.throws(() => execFileSync(process.execPath, ['scripts/eval.ts', '--surface', 'console-api'], { encoding: 'utf8', stdio: 'pipe' }), /Provider options require --live/);
    const help = execFileSync(process.execPath, ['scripts/eval.ts', '--help'], { encoding: 'utf8' });
    assert.match(help, /--surface cli\|console-api/);
  });
});
