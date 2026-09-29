import assert from 'node:assert/strict';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { RunMeta } from '../src/types.ts';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'bin', 'crew');
const saved = { ...process.env };
let dir: string;
let env: NodeJS.ProcessEnv;
const parent = { mailbox: 'claude-root', host: 'claude' as const };
const store = await import('../src/store.ts');
const mail = await import('../src/mail.ts');
const { watch } = await import('../src/wait.ts');
const { self } = await import('../src/identity.ts');

// Entire host surfaces are fixtures. No real daemon, credentials, config, pane or transcript.
const hostShim = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), p = process.env;
const log = value => fs.appendFileSync(p.SHIM_LOG, JSON.stringify(value) + '\\n');
const cli = (a, input) => cp.execFileSync(p.SHIM_CREW, a, {env:p, input, encoding:'utf8'});
const worker = async () => {
  const id = p.CREW_RUN, base = path.join(p.CREW_HOME, 'runs', id);
  fs.writeFileSync(path.join(base,'.fixture-active'),'');
  process.on('exit',()=>{try{fs.unlinkSync(path.join(base,'.fixture-active'))}catch{}});
  const session = p.SHIM_SESSION || 'session-' + id;
  const resuming = p.SHIM_RESUME || args.includes('resume') || args.includes('--session');
  log({worker:id, session, resuming:Boolean(resuming), args, config:p.CREW_CONFIG, roster:p.CREW_ROSTER});
  cli(['hook','session-start','--host',p.SHIM_HOST], JSON.stringify({session_id:session}));
  if (p.SHIM_HOST === 'codex') p.CODEX_THREAD_ID = session;
  else p.CLAUDE_CODE_SESSION_ID = session;
  const packet = fs.readFileSync(path.join(base,'packet.md'),'utf8');
  if (resuming && p.SHIM_FAIL_RESUME) process.exit(3);
  if (packet.includes('EXIT_WITHOUT_RESULT')) process.exit(3);
  const result = status => fs.writeFileSync(path.join(base,'result.md'), '# Status\\n' + status + '\\n# Claims\\nfixture\\n');
  if (packet.includes('WAIT_FOR_MAIL')) {
    result('IN PROGRESS: waiting for fixture mail');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const out = cli(['inbox']);
      if (out !== 'no new mail\\n') {
        cli(['msg','parent','ACK ' + out.trim()]);
        result('DONE: ' + out.trim());
        cli(['hook','stop','--host',p.SHIM_HOST],JSON.stringify({session_id:session}));
        return;
      }
      await new Promise(r=>setTimeout(r,50));
    }
    process.exit(4);
  }
  result(resuming ? 'DONE: resumed ' + cli(['inbox']).trim() : 'DONE: initial fixture assignment');
  cli(['hook','stop','--host',p.SHIM_HOST],JSON.stringify({session_id:session}));
};
if (args[0] === 'worker' || args[0] === 'exec' || args[0] === 'run') {
  worker().catch(e=>{ console.error(e); process.exit(1); });
} else if (args[0] === 'queue') {
  const thread = args[args.indexOf('--thread')+1];
  const inbox = path.join(p.CREW_HOME,'mail','codex-' + thread,'inbox.jsonl');
  log({queue:thread, visible:fs.existsSync(inbox)?fs.readFileSync(inbox,'utf8'):''});
  if(p.SHIM_FAIL_WAKE) process.exit(2);
  if(p.SHIM_SLOW_WAKE) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
} else if (args[0] === '--bg') {
  const previous=fs.existsSync(p.SHIM_SESSIONS)?fs.readFileSync(p.SHIM_SESSIONS,'utf8').trim().split('\\n').filter(Boolean).map(l=>JSON.parse(l)).findLast(r=>r.sessionId===args[args.indexOf('--resume')+1]):undefined;
  const settings = args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings')+1]) : {env:previous.settingsEnv};
  const session = args.includes('--resume') && !p.SHIM_COPY_RESUME ? args[args.indexOf('--resume')+1] : require('node:crypto').randomUUID();
  log({bg:true,session,args});
  const child = cp.spawn(process.execPath,[__filename,'worker'],{env:{...p,...settings.env,SHIM_HOST:'claude',SHIM_SESSION:session,...(args.includes('--resume')?{SHIM_RESUME:'1'}:{})},detached:true,stdio:'ignore'});
  child.unref();
  const row = {id:session.slice(0,8), run:settings.env.CREW_RUN, settingsEnv:settings.env, home:settings.env.CREW_HOME, sessionId:session, name:args.includes('--name')?args[args.indexOf('--name')+1]:previous.name, state:'done', pid:child.pid};
  fs.appendFileSync(p.SHIM_SESSIONS,JSON.stringify(row)+'\\n');
  console.log('backgrounded · ' + row.id + ' · ' + row.name + '\\n  claude agents              list sessions');
} else if (args[0] === 'agents') {
  if(p.SHIM_EXPECT_CLAUDE_CONFIG && p.CLAUDE_CONFIG_DIR!==p.SHIM_EXPECT_CLAUDE_CONFIG){console.log('[]');process.exit(0);}
  if(p.SHIM_FAIL_PROBE) { console.error('socket timeout'); process.exit(2); }
  if(p.SHIM_INVALID_PROBE) { console.log('{}'); process.exit(0); }
  const rows=fs.existsSync(p.SHIM_SESSIONS)?fs.readFileSync(p.SHIM_SESSIONS,'utf8').trim().split('\\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  const unique=Object.values(Object.fromEntries(rows.map(r=>[r.id,r])));
  for(const row of unique) { row.state=row.stopped?'stopped':row.run ? (fs.existsSync(path.join(row.home,'runs',row.run,'.fixture-active'))?'working':'done') : 'working'; }
  console.log(JSON.stringify(args.includes('--all')?unique:unique.filter(r=>r.state==='working'||r.state==='blocked')));
} else if (args[0] === 'stop') {
  log({stop:args[1]});
  if(p.SHIM_FAIL_STOP)process.exit(2);
  const rows=fs.readFileSync(p.SHIM_SESSIONS,'utf8').trim().split('\\n').map(l=>JSON.parse(l));
  for(const row of rows) if(row.id===args[1]) {try{process.kill(-row.pid,'SIGTERM')}catch{};fs.appendFileSync(p.SHIM_SESSIONS,JSON.stringify({...row,stopped:true})+'\\n');}
} else {
  log({args});
}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-lifecycle-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const host of ['codex', 'claude', 'opencode']) writeFileSync(join(bin, host), hostShim, { mode: 0o755 });
  // Every subprocess gets a clean identity and isolated host homes.
  env = { ...saved, HOME: dir, CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    CREW_HOME: join(dir, 'crew'), CREW_CONFIG: join(dir, 'config.json'), CREW_ROSTER: join(dir, 'roster.json'),
    PATH: `${bin}:${saved.PATH}`, SHIM_LOG: join(dir, 'hosts.jsonl'), SHIM_SESSIONS: join(dir, 'sessions.jsonl'),
    SHIM_CREW: CLI, SHIM_HOST: 'codex', CODEX_THREAD_ID: 'root', CREW_NO_DELEGATE: '1',
  };
  for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_OPENCODE_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID', 'HERDR_BIN_PATH', 'CREW_ROUTER']) delete env[key];
  writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: false, command: join(dir, 'absent-router') }, trust: { roots: [] } }));
  Object.assign(process.env, { HOME: env.HOME, CODEX_HOME: env.CODEX_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    CREW_HOME: env.CREW_HOME, CREW_CONFIG: env.CREW_CONFIG, CREW_ROSTER: env.CREW_ROSTER,
    PATH: env.PATH, SHIM_LOG: env.SHIM_LOG, SHIM_SESSIONS: env.SHIM_SESSIONS });
});

afterEach(() => {
  // Only pids recorded by this fixture: detached workers and watchers are owned by the test.
  const pids = store.listRuns().flatMap(r => r.pid ? [r.pid] : []);
  if (existsSync(env.SHIM_SESSIONS!)) pids.push(...readFileSync(env.SHIM_SESSIONS!, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).pid));
  for (const mailbox of ['codex-root', 'claude-root']) {
    try { pids.push(Number(readFileSync(join(store.mailDir(mailbox), 'watcher'), 'utf8'))); } catch { /* none */ }
  }
  for (const pid of pids) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } }
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
});

const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}) => (await exec(CLI, args, { env: { ...env, ...extra }, timeout: 20000 })).stdout.trim();
const fixtureRun = (extra: Partial<RunMeta> = {}) => {
  const run: RunMeta = { id: 'b-test', name: 'fixture', role: 'builder', parent,
    route: { host: 'codex', model: 'gpt-6.1-sol', effort: 'low', strategy: 'pinned' },
    launcher: 'exec', keep: false, cwd: dir, createdAt: new Date().toISOString(), state: 'running', ...extra };
  store.writeRun(run);
  writeFileSync(store.packetPath(run.id), 'fixture packet\n');
  return run;
};
const result = (status: string) => writeFileSync(store.resultPath('b-test'), `# Status\n${status}\n# Claims\nfixture\n`);
const hostCalls = () => existsSync(env.SHIM_LOG!) ? readFileSync(env.SHIM_LOG!, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture timed out: ' + JSON.stringify({ runs: store.listRuns(), calls: hostCalls(), resumeLogs: store.listRuns().map(r => { try { return readFileSync(join(store.runDir(r.id), 'resume.log'), 'utf8').slice(-1200); } catch { return ''; } }) })); await sleep(25); }
};

describe('cross-process delivery and lifecycle regressions', () => {
  it('persists mail before a Codex wake can read it', () => {
    mail.send(parent, { mailbox: 'codex-root', host: 'codex', threadId: 'root' }, 'visible before wake');
    assert.match(hostCalls()[0].visible, /visible before wake/);
  });

  it('keeps mail durable when the wake fails', () => {
    process.env.SHIM_FAIL_WAKE = '1';
    assert.equal(mail.send(parent, { mailbox: 'codex-root', host: 'codex', threadId: 'root' }, 'retry me'), 'queued');
    assert.equal(mail.takeUnread('codex-root')[0]?.text, 'retry me');
  });

  it('deduplicates simultaneous wakes across processes', async () => {
    const args = ['msg', 'codex-root', 'fixture mail'];
    await Promise.all([cli(args, { SHIM_SLOW_WAKE: '1' }), cli(args, { SHIM_SLOW_WAKE: '1' }), cli(args, { SHIM_SLOW_WAKE: '1' })]);
    assert.equal(hostCalls().filter(c => c.queue).length, 1);
    assert.equal(mail.takeUnread('codex-root').length, 3);
  });

  it('does not rewind a cursor when an older reader commits late', () => {
    store.appendMail('mb', { id: 'one', at: '', kind: 'message', from: parent, text: 'one' });
    const old = store.unread('mb');
    store.appendMail('mb', { id: 'two', at: '', kind: 'message', from: parent, text: 'two' });
    store.unread('mb').commit();
    old.commit();
    assert.deepEqual(store.unread('mb').mails, []);
  });

  it('consumes a mail batch once when two CLI readers race', async () => {
    store.appendMail('codex-root', { id: 'one', at: '', kind: 'message', from: parent, text: 'one batch' });
    const outputs = await Promise.all([cli(['inbox']), cli(['inbox'])]);
    assert.equal(outputs.filter(out => out.includes('one batch')).length, 1);
  });

  it('commits from the beginning after inbox truncation', () => {
    store.appendMail('mb', { id: 'one', at: '', kind: 'message', from: parent, text: 'a long original batch'.repeat(20) });
    mail.takeUnread('mb');
    writeFileSync(join(store.mailDir('mb'), 'inbox.jsonl'), '');
    store.appendMail('mb', { id: 'two', at: '', kind: 'message', from: parent, text: 'new batch' });
    assert.equal(mail.takeUnread('mb')[0]?.id, 'two');
    assert.deepEqual(mail.takeUnread('mb'), []);
  });

  it('merges simultaneous metadata patches instead of losing a field', async () => {
    fixtureRun();
    const module = JSON.stringify(join(REPO, 'src', 'store.ts'));
    const marker = join(dir, 'entered');
    const first = exec(process.execPath, ['--input-type=module', '-e', `
      import {writeFileSync} from 'node:fs';
      const s=await import(${module});
      s.updateRun('b-test', r=>{writeFileSync(${JSON.stringify(marker)},''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250); return {...r,sessionId:'session'};});
    `], { env });
    await until(() => existsSync(marker));
    await exec(process.execPath, ['--input-type=module', '-e', `const s=await import(${module}); s.updateRun('b-test',r=>({...r,threadId:'thread'}));`], { env });
    await first;
    assert.equal(store.readRun('b-test')?.sessionId, 'session');
    assert.equal(store.readRun('b-test')?.threadId, 'thread');
  });

  it('does not settle a stopped run or consume a stopped run amendment', () => {
    fixtureRun({ state: 'stopped' }); result('DONE');
    assert.equal(mail.settle('b-test'), undefined);
    assert.equal(store.readRun('b-test')?.state, 'stopped');
    assert.throws(() => mail.amend(parent, 'b-test', 'new assignment'), /stopped/);
    assert.equal(readFileSync(store.packetPath('b-test'), 'utf8'), 'fixture packet\n');
  });

  it('requires a fresh result after an amendment, even after inbox consumption', () => {
    fixtureRun(); result('DONE: original');
    mail.amend(parent, 'b-test', 'new acceptance criterion');
    mail.takeUnread('b-test');
    assert.equal(mail.settle('b-test'), undefined);
    result('DONE: original plus new acceptance criterion');
    assert.equal(mail.settle('b-test'), 'queued');
  });

  it('reports an exited child with an obsolete result as stalled', async () => {
    fixtureRun({ pid: 999999 }); result('DONE: original');
    mail.amend(parent, 'b-test', 'unfinished work');
    await watch(parent.mailbox, 10, 100);
    assert.equal(store.readRun('b-test')?.state, 'stalled');
    assert.deepEqual(mail.takeUnread(parent.mailbox).map(m => m.kind), ['stalled']);
  });

  it('uses the innermost OpenCode session instead of an inherited crew run', () => {
    fixtureRun({ sessionId: 'own' });
    assert.equal(self({ CREW_RUN: 'b-test', CREW_OPENCODE_SESSION: 'other' }).mailbox, 'opencode-other');
  });

  it('preserves Claude authentication env while stripping parent session markers', async () => {
    const { bgInvocation } = await import('../src/spawn.ts');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-token';
    process.env.CLAUDE_SESSION_ID = 'parent-session';
    const call = bgInvocation(['GO'], { CREW_RUN: 'b-child' });
    assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-token');
    assert.equal(call.env.CLAUDE_SESSION_ID, undefined);
    assert.ok(!call.argv.some(arg => arg.includes('fixture-token')), 'credentials stay out of argv');
  });

  it('retries failed OpenCode wake requests and keeps foreign sessions out of the run inbox', async () => {
    fixtureRun({ sessionId: 'own' });
    process.env.CREW_RUN = 'b-test';
    process.env.CREW_OPENCODE_POLL_MS = '10';
    const hook = join(dir, 'hook');
    writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
    process.env.CREW_BIN = hook;
    const { CrewPlugin } = await import(`${join(REPO, 'opencode', 'crew.js')}?retry=${Date.now()}`);
    const attempts: string[] = [];
    const plugin = await CrewPlugin({ client: { session: { promptAsync: async (request: { path: { id: string } }) => {
      attempts.push(request.path.id);
      if (attempts.length === 1) throw new Error('transient fixture failure');
    } } } });
    for (const id of ['own', 'foreign']) await plugin.event({ event: { type: 'session.created', properties: { info: { id } } } });
    mail.send(parent, { mailbox: 'b-test', host: 'opencode' }, 'fixture mail');
    await until(() => attempts.length >= 2);
    assert.deepEqual(attempts, ['own', 'own']);
    mail.takeUnread('b-test');
  });

  it('spaces keepalives even when a queued pointer has not touched the transcript yet', async () => {
    const child = spawnProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    fixtureRun({ pid: child.pid!, parent: { mailbox: 'codex-root', host: 'codex', threadId: 'root' } });
    const transcript = join(env.CODEX_HOME!, 'sessions', '2026', '09', '29', 'rollout-root.jsonl');
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    const cold = new Date(Date.now() - 30 * 60000);
    utimesSync(transcript, cold, cold);
    await watch('codex-root', 10, 1000);
    assert.equal(hostCalls().filter(c => c.queue).length, 1);
  });
});

describe('isolated CLI lifecycle through host shims', () => {
  it('launches, messages and closes a Herdr child through its recorded session and pane', async () => {
    const herdr = join(dir, 'bin', 'herdr');
    const paneFile = join(dir, 'pane.json');
    writeFileSync(herdr, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const original=process.argv.slice(2);let a=[...original];if(a[0]==='--session')a=a.slice(2);
fs.appendFileSync(process.env.SHIM_LOG,JSON.stringify({herdr:original})+'\\n');
if(a[0]==='pane'&&a[1]==='split'){
  const env={};for(let i=0;i<a.length;i++)if(a[i]==='--env'){const value=a[++i],eq=value.indexOf('=');env[value.slice(0,eq)]=value.slice(eq+1);}
  fs.writeFileSync(${JSON.stringify(paneFile)},JSON.stringify(env));console.log(JSON.stringify({pane_id:'w1:p2'}));
}else if(a[0]==='agent'&&a[1]==='start'){
  const env=JSON.parse(fs.readFileSync(${JSON.stringify(paneFile)},'utf8'));
  const child=cp.spawn(process.execPath,[${JSON.stringify(join(dir, 'bin', 'codex'))},'worker'],{env:{...process.env,...env,SHIM_HOST:a[a.indexOf('--kind')+1]},detached:true,stdio:'ignore'});child.unref();
  fs.appendFileSync(process.env.SHIM_SESSIONS,JSON.stringify({pid:child.pid})+'\\n');console.log('{}');
}else if(a[0]==='agent'&&a[1]==='get'){
  const env=JSON.parse(fs.readFileSync(${JSON.stringify(paneFile)},'utf8'));
  const meta=JSON.parse(fs.readFileSync(require('node:path').join(env.CREW_HOME,'runs',env.CREW_RUN,'meta.json'),'utf8'));
  console.log(JSON.stringify({agent_status:meta.state==='done'?'done':'working'}));
}else console.log('{}');
`, { mode: 0o755 });
    const herdrEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'fixture-session', HERDR_BIN_PATH: herdr };
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--name', 'pane-fixture', '--cwd', dir, '--json', '--', 'WAIT_FOR_MAIL'], herdrEnv));
    assert.equal(run.launcher, 'herdr');
    assert.deepEqual(run.herdr, { pane: 'w1:p2', agent: 'w1:p2', session: 'fixture-session' });
    await until(() => Boolean(store.readRun(run.id)?.sessionId));
    await cli(['msg', run.id, 'fixture advice'], herdrEnv);
    await until(() => store.readRun(run.id)?.state === 'done');
    assert.match(await cli(['inbox']), /ACK \[message\]/);
    await until(() => store.readRun(run.id)?.herdr?.closed === true);
    assert.ok(hostCalls().some(c => c.herdr?.includes('close')));
    const calls = hostCalls().filter(c => c.herdr).map(c => c.herdr as string[]);
    assert.ok(calls.every(a => a[0] === '--session' && a[1] === 'fixture-session'));
    assert.ok(calls.some(a => a.includes('start') && a.includes('w1:p2')));
    assert.ok(calls.some(a => a.includes('close') && a.at(-1) === 'w1:p2'));
  });

  it('launches Codex, exchanges parent/child mail, applies an amendment and settles', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--name', 'codex-fixture', '--cwd', dir, '--json', '--', 'WAIT_FOR_MAIL']));
    await until(() => Boolean(store.readRun(run.id)?.sessionId));
    assert.equal(store.readRun(run.id)?.threadId, `session-${run.id}`);
    await cli(['amend', run.id, 'finish with evidence for the added criterion']);
    await until(() => store.readRun(run.id)?.state === 'done');
    const notices = await cli(['inbox']);
    assert.match(notices, /ACK \[amendment\]/);
    assert.match(notices, /\[settled\]/);
    assert.match(await cli(['read', run.id]), /DONE: \[amendment\]/);
    assert.equal(await cli(['inbox']), 'no new mail');
    assert.equal(hostCalls().filter(c => c.queue?.startsWith('session-')).length, 0, 'never queue pointers into exec children');
  });

  it('launches Claude bg with isolated state in session settings and settles to Codex', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'sonnet@low', '--name', 'claude-fixture', '--cwd', dir, '--json', '--', 'initial assignment']));
    assert.equal(run.launcher, 'bg');
    assert.match(run.bgId!, /^[0-9a-f]{8}$/);
    await until(() => store.readRun(run.id)?.state === 'done');
    const worker = hostCalls().find(c => c.worker === run.id);
    assert.equal(worker.config, env.CREW_CONFIG);
    assert.equal(worker.roster, env.CREW_ROSTER);
    assert.match(await cli(['inbox']), /\[settled\]/);
    assert.match(await cli(['ls', '--json']), /claude-fixture/);
  });

  it('detects exec exit without a result through crew wait', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--json', '--', 'EXIT_WITHOUT_RESULT']));
    assert.match(await cli(['wait', '--timeout', '8s']), /\[stalled\]/);
    assert.equal(store.readRun(run.id)?.state, 'stalled');
  });

  it('stops a worker, stops its process group and prevents late settlement', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--json', '--', 'WAIT_FOR_MAIL']));
    await until(() => Boolean(store.readRun(run.id)?.sessionId));
    await cli(['stop', run.id]);
    assert.equal(store.readRun(run.id)?.state, 'stopped');
    writeFileSync(store.resultPath(run.id), '# Status\nDONE: late result\n');
    assert.equal(mail.settle(run.id), undefined);
    assert.equal(await cli(['inbox']), 'no new mail');
  });

  it('rejects a simultaneous same-name launch after routing', async () => {
    const router = join(dir, 'router');
    writeFileSync(router, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({selected:{model:'gpt-6.1-sol',thinking:'low'},strategy:'jev'})),200));\n`, { mode: 0o755 });
    writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: true, command: router }, trust: { roots: [] } }));
    const args = ['spawn', '--role', 'builder', '--name', 'same-name', '--cwd', dir, '--json', '--', 'WAIT_FOR_MAIL'];
    const attempts = await Promise.allSettled([cli(args), cli(args)]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(store.listRuns().length, 1);
  });

  it('reserves capacity across simultaneous routed launches', async () => {
    const router = join(dir, 'router');
    writeFileSync(router, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({selected:{model:'sonnet',thinking:'low'},strategy:'jev'})),200));\n`, { mode: 0o755 });
    writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: true, command: router }, capacity: { claude: { max: 1, overflow: 'gpt-6.1-sol@low' } }, trust: { roots: [] } }));
    const args = ['spawn', '--role', 'builder', '--cwd', dir, '--json', '--', 'WAIT_FOR_MAIL'];
    const runs: RunMeta[] = (await Promise.all([cli(args), cli(args)])).map(out => JSON.parse(out));
    assert.deepEqual(runs.map(r => r.route.host).sort(), ['claude', 'codex']);
    assert.equal(runs.find(r => r.route.host === 'codex')?.route.strategy, 'overflow');
  });

  for (const model of ['gpt-6.1-sol@low', 'sonnet@low', 'opencode/provider/fixture']) {
    it(`resumes a retained ${model} session for a new amendment without changing ownership`, async () => {
      const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'advisor', '--keep', '--model', model, '--cwd', dir, '--json', '--', 'initial assignment'],
        { SHIM_HOST: model.startsWith('opencode/') ? 'opencode' : 'codex' }));
      await until(() => Boolean(store.readRun(run.id)?.settled));
      await until(() => !existsSync(join(store.runDir(run.id), '.fixture-active')));
      const first = store.readRun(run.id)!;
      if (first.pid) await until(() => !store.alive(first.pid));
      assert.match(await cli(['amend', run.id, 'a second assignment'], { SHIM_HOST: first.route.host }), /headless-resume$/);
      await until(() => /resumed/.test(store.readRun(run.id)?.settled?.status ?? ''));
      assert.equal(store.readRun(run.id)?.sessionId, first.sessionId);
      assert.equal(store.readRun(run.id)?.state, 'running');
      assert.equal(store.unread(run.id).mails.length, 0);
      assert.match(readFileSync(store.resultPath(run.id), 'utf8'), /a second assignment/);
      assert.equal(hostCalls().filter(c => c.worker).length, 2);
      if (first.route.host === 'codex') assert.equal(hostCalls().filter(c => c.queue === first.sessionId).length, 0);
      await cli(['stop', run.id]);
    });
  }

  it('serializes competing explicit resumes into one new turn', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--json', '--', 'initial assignment']));
    await until(() => Boolean(store.readRun(run.id)?.settled) && !store.alive(store.readRun(run.id)?.pid));
    const outputs = await Promise.all([cli(['resume', run.id]), cli(['resume', run.id]), cli(['resume', run.id])]);
    assert.equal(outputs.filter(o => o.endsWith(': resumed')).length, 1);
    await until(() => hostCalls().filter(c => c.worker).length === 2);
    assert.equal(store.readRun(run.id)?.sessionId, 'session-' + run.id);
  });

  it('refuses a stopped headless resume and leaves its identity untouched', async () => {
    const run = fixtureRun({ state: 'stopped', sessionId: 'owned', launch: { args: ['prompt'], env: {} } });
    await assert.rejects(cli(['resume', run.id]), /stopped/);
    assert.equal(store.readRun(run.id)?.state, 'stopped');
    assert.deepEqual(hostCalls(), []);
  });

  it('does not resume a busy or uninspectable Claude session', async () => {
    const run = fixtureRun({ launcher: 'bg', bgId: 'immutable', sessionId: 'session', launch: { args: ['prompt'], env: {} }, route: { host: 'claude', model: 'sonnet', effort: 'low', strategy: 'pinned' } });
    writeFileSync(env.SHIM_SESSIONS!, JSON.stringify({ id: 'immutable', sessionId: 'session', name: run.name, pid: process.pid }) + '\n');
    assert.match(await cli(['resume', run.id]), /already active/);
    assert.match(await cli(['resume', run.id], { SHIM_FAIL_PROBE: '1' }), /unavailable/);
    assert.equal(hostCalls().filter(c => c.bg).length, 0);
  });

  it('keeps watching during unavailable Herdr and Claude liveness probes', async () => {
    const herdr = join(dir, 'bin', 'herdr');
    writeFileSync(herdr, `#!${process.execPath}\nconsole.error('socket timeout');process.exit(2);\n`, { mode: 0o755 });
    fixtureRun({ launcher: 'herdr', herdr: { agent: 'pane', pane: 'pane', session: 'owned' }, waitingSince: 'earlier' });
    await watch(parent.mailbox, 10, 50);
    assert.equal(store.readRun('b-test')?.state, 'running');
    assert.equal(store.readRun('b-test')?.waitingSince, 'earlier');
    fixtureRun({ launcher: 'bg', bgId: 'immutable', waitingSince: 'earlier' });
    process.env.SHIM_FAIL_PROBE = '1';
    await watch(parent.mailbox, 10, 50);
    assert.equal(store.readRun('b-test')?.state, 'running');
    assert.equal(store.readRun('b-test')?.waitingSince, 'earlier');
    delete process.env.SHIM_FAIL_PROBE;
    process.env.SHIM_INVALID_PROBE = '1';
    await watch(parent.mailbox, 10, 50);
    assert.equal(store.readRun('b-test')?.state, 'running');
  });

  it('detects confirmed absence and ignores a same-name foreign background session', async () => {
    writeFileSync(join(dir, 'bin', 'herdr'), `#!${process.execPath}\nconsole.error(JSON.stringify({error:{code:'agent_not_found',message:'missing'}}));process.exit(1);\n`, { mode: 0o755 });
    fixtureRun({ launcher: 'herdr', herdr: { agent: 'pane', pane: 'pane' } });
    await watch(parent.mailbox, 10, 50);
    assert.equal(store.readRun('b-test')?.state, 'stalled');
    rmSync(join(store.runDir('b-test'), '.stalled'));
    fixtureRun({ launcher: 'bg', bgId: 'original' });
    writeFileSync(env.SHIM_SESSIONS!, JSON.stringify({ id: 'foreign', name: 'fixture', pid: process.pid }) + '\n');
    await watch(parent.mailbox, 10, 50);
    assert.equal(store.readRun('b-test')?.state, 'stalled');
  });

  it('recovers a settlement crash before metadata and after inbox append without duplicate notices', () => {
    const original = fixtureRun(); result('DONE: crash recovery');
    mail.settle(original.id);
    const settled = store.readRun(original.id)!.settled!;
    const event = join(store.runDir(original.id), `.settled-${settled.hash}`);
    // A claim/outbox was durable, but the process died before metadata/delivery acknowledgement.
    store.writeJson(event, { ...settled, notified: false });
    store.writeRun(original);
    assert.equal(mail.settle(original.id), 'queued');
    assert.equal(mail.takeUnread(parent.mailbox).length, 1);
    // A second crash after inbox append, even after the parent consumes it, does not replay mail.
    store.updateRun(original.id, r => ({ ...r, settled: { ...settled, notified: false } }));
    store.writeJson(event, { ...settled, notified: false });
    mail.settle(original.id);
    assert.equal(mail.takeUnread(parent.mailbox).length, 0);
    assert.equal(store.readRun(original.id)?.settled?.notified, true);
  });

  it('reports a resumed worker that exits with unread mail instead of retrying forever', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--keep', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--json', '--', 'initial assignment']));
    await until(() => Boolean(store.readRun(run.id)?.settled) && !store.alive(store.readRun(run.id)?.pid));
    await cli(['amend', run.id, 'new work'], { SHIM_FAIL_RESUME: '1' });
    await until(() => (store.readRun(run.id)?.turn ?? 0) > 0 && !store.alive(store.readRun(run.id)?.pid));
    await watch('codex-root', 20, 100);
    assert.equal(store.readRun(run.id)?.state, 'stalled');
    assert.ok(mail.takeUnread('codex-root').some(m => m.kind === 'stalled'));
    const count = hostCalls().filter(c => c.worker).length;
    await watch('codex-root', 20, 100);
    assert.equal(hostCalls().filter(c => c.worker).length, count);
    assert.match(await cli(['resume', run.id]), /resumed/);
    await until(() => /resumed/.test(store.readRun(run.id)?.settled?.status ?? ''));
  });

  it('keeps a pane close retryable after a host transport failure', async () => {
    const herdr = join(dir, 'bin', 'herdr');
    writeFileSync(herdr, `#!${process.execPath}\nif(process.argv.includes('get'))console.log(JSON.stringify({agent_status:'done'}));else{console.error('socket unavailable');process.exit(2)}\n`, { mode: 0o755 });
    fixtureRun({ launcher: 'herdr', herdr: { agent: 'pane', pane: 'pane', session: 'owned' } }); result('DONE');
    await watch(parent.mailbox, 20, 80);
    assert.notEqual(store.readRun('b-test')?.herdr?.closed, true);
    writeFileSync(herdr, `#!${process.execPath}\nconsole.log(JSON.stringify({agent_status:'done'}));\n`, { mode: 0o755 });
    await watch(parent.mailbox, 20, 80);
    assert.equal(store.readRun('b-test')?.herdr?.closed, true);
  });

  it('uses isolated host trust files for a fresh checkpoint-based launch', async () => {
    mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true }); mkdirSync(env.CODEX_HOME!, { recursive: true });
    const claude = join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), codex = join(env.CODEX_HOME!, 'config.toml');
    writeFileSync(claude, JSON.stringify({ projects: {}, keep: 'unchanged' })); writeFileSync(codex, 'model = "fixture"\n');
    writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: false }, trust: { roots: [dir] } }));
    await cli(['trust', dir]);
    const real = (await import('node:fs')).realpathSync(dir);
    assert.equal(JSON.parse(readFileSync(claude, 'utf8')).projects[real].hasTrustDialogAccepted, true);
    assert.match(readFileSync(codex, 'utf8'), /trust_level = "trusted"/);
    assert.equal(existsSync(join(dir, '.claude.json')), false);
    const first: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--json', '--', 'initial checkpoint assignment']));
    await until(() => Boolean(store.readRun(first.id)?.settled) && !store.alive(store.readRun(first.id)?.pid));
    const checkpoint = join(dir, 'checkpoint.md');
    writeFileSync(checkpoint, `Continue from packet ${store.packetPath(first.id)} and result ${store.resultPath(first.id)}. Remaining: verify the new criterion.\n`);
    const next: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'gpt-6.1-sol@low', '--cwd', dir, '--packet', checkpoint, '--json']));
    await until(() => Boolean(store.readRun(next.id)?.settled));
    assert.notEqual(next.id, first.id);
    assert.notEqual(store.readRun(next.id)?.sessionId, store.readRun(first.id)?.sessionId);
    assert.match(readFileSync(store.packetPath(next.id), 'utf8'), new RegExp(first.id));
    assert.match(readFileSync(store.resultPath(first.id), 'utf8'), /initial fixture assignment/);
  });

  it('detects the explicitly recorded Node runtime even with forced colour and no Node on PATH', async () => {
    assert.match(await cli(['whoami'], { PATH: '/usr/bin:/bin', CREW_NODE: process.execPath, FORCE_COLOR: '1' }), /codex-root/);
  });

  it('uses the run host home rather than a pre-existing watcher host home', async () => {
    const run = fixtureRun({ launcher: 'bg', bgId: 'immutable', sessionId: 'session', launch: { args: [], env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR! } } });
    writeFileSync(env.SHIM_SESSIONS!, JSON.stringify({ id: 'immutable', sessionId: 'session', name: run.name, pid: process.pid }) + '\n');
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'wrong-host-home');
    process.env.SHIM_EXPECT_CLAUDE_CONFIG = env.CLAUDE_CONFIG_DIR;
    await watch(parent.mailbox, 20, 80);
    assert.equal(store.readRun(run.id)?.state, 'running');
    assert.equal(mail.takeUnread(parent.mailbox).length, 0);
  });

  it('stops an unexpected Claude resume copy and retains the original session identity', async () => {
    const run: RunMeta = JSON.parse(await cli(['spawn', '--role', 'builder', '--model', 'sonnet@low', '--cwd', dir, '--json', '--', 'initial assignment']));
    await until(() => Boolean(store.readRun(run.id)?.settled) && !existsSync(join(store.runDir(run.id), '.fixture-active')));
    const original = store.readRun(run.id)!;
    await assert.rejects(cli(['resume', run.id], { SHIM_COPY_RESUME: '1' }), /copied.*stopped the copy/);
    assert.equal(store.readRun(run.id)?.sessionId, original.sessionId);
    assert.equal(store.readRun(run.id)?.bgId, original.bgId);
    assert.ok(hostCalls().some(c => c.stop && c.stop !== original.bgId));
  });

  it('reports an unsuccessful explicit stop without pretending the host closed', async () => {
    const herdr = join(dir, 'bin', 'herdr');
    writeFileSync(herdr, `#!${process.execPath}\nconsole.error('transport failure');process.exit(2);\n`, { mode: 0o755 });
    fixtureRun({ launcher: 'herdr', herdr: { agent: 'pane', pane: 'pane', session: 'owned' } });
    await assert.rejects(cli(['stop', 'b-test']), /pane close failed/);
    assert.equal(store.readRun('b-test')?.state, 'stopped');
    assert.notEqual(store.readRun('b-test')?.herdr?.closed, true);
    fixtureRun({ launcher: 'bg', bgId: 'immutable' });
    writeFileSync(env.SHIM_SESSIONS!, JSON.stringify({ id: 'immutable', sessionId: 'session', name: 'fixture', pid: process.pid }) + '\n');
    await assert.rejects(cli(['stop', 'b-test'], { SHIM_FAIL_STOP: '1' }), /background stop failed/);
    assert.equal(store.readRun('b-test')?.state, 'stopped');
  });

  it('delivers a committed settlement even after the child starts a newer draft', () => {
    const run = fixtureRun(); result('DONE: committed phase');
    mail.settle(run.id);
    const settled = store.readRun(run.id)!.settled!;
    rmSync(store.mailDir(parent.mailbox), { recursive: true, force: true }); // crash before parent append
    store.updateRun(run.id, current => ({ ...current, settled: { ...settled, notified: false } }));
    store.writeJson(join(store.runDir(run.id), `.settled-${settled.hash}`), { ...settled, notified: false });
    result('IN PROGRESS: subsequent assignment');
    assert.equal(mail.settle(run.id), 'queued');
    assert.equal(mail.takeUnread(parent.mailbox)[0]?.text.includes('committed phase'), true);
    assert.equal(store.readRun(run.id)?.settled?.notified, true);
  });

  it('reports an inactive Claude turn with unread attempted mail as stalled', async () => {
    const run = fixtureRun({ launcher: 'bg', bgId: 'immutable', sessionId: 'session', resumedMail: 'pending',
      launch: { args: [], env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR! } } });
    writeFileSync(env.SHIM_SESSIONS!, JSON.stringify({ id: 'immutable', sessionId: 'session', name: run.name, pid: 999999, run: run.id, home: env.CREW_HOME }) + '\n');
    store.appendMail(run.id, { id: 'pending', at: '', kind: 'amendment', from: parent, text: 'unfinished' });
    await watch(parent.mailbox, 20, 80);
    assert.equal(store.readRun(run.id)?.state, 'stalled');
    assert.ok(mail.takeUnread(parent.mailbox).some(m => m.kind === 'stalled'));
  });

  it('does not mistake a serialized relaunch gap for worker death', async () => {
    const run = fixtureRun({ pid: 999999 });
    const lock = join(env.CREW_HOME!, 'locks', `resume-${run.id}`); mkdirSync(lock, { recursive: true });
    await watch(parent.mailbox, 20, 80);
    assert.equal(store.readRun(run.id)?.state, 'running');
    rmSync(lock, { recursive: true });
    await watch(parent.mailbox, 20, 80);
    assert.equal(store.readRun(run.id)?.state, 'stalled');
  });

  it('runs the installer idempotently in a temporary home and preserves unrelated settings', async () => {
    mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const settings = join(dir, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ env: { KEEP_THIS: 'yes', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, enabledPlugins: { 'unrelated@plugin': true } }));
    const config = join(dir, '.codex', 'config.toml');
    writeFileSync(config, 'model = "fixture"\n[sandbox_workspace_write]\nwritable_roots = ["/fixture/other"]\n');
    const install = () => exec(process.execPath, [join(REPO, 'scripts', 'install.ts')], { env, timeout: 15000 });
    await install();
    const firstSettings = readFileSync(settings, 'utf8');
    const firstConfig = readFileSync(config, 'utf8');
    await install();
    assert.equal(readFileSync(settings, 'utf8'), firstSettings);
    assert.equal(readFileSync(config, 'utf8'), firstConfig);
    assert.deepEqual(JSON.parse(firstSettings).env, { KEEP_THIS: 'yes' });
    assert.equal(JSON.parse(firstSettings).enabledPlugins['unrelated@plugin'], true);
    assert.match(firstConfig, /\/fixture\/other/);
    assert.match(firstConfig, /\.crew/);
  });

  it('marks a missing executable launch failed without an unhandled spawn error', async () => {
    rmSync(join(dir, 'bin', 'opencode'));
    // No installed OpenCode is used.
    await assert.rejects(cli(['spawn', '--role', 'builder', '--model', 'opencode/provider/fixture', '--cwd', dir, '--json', '--', 'test'], { PATH: `${join(dir, 'bin')}:/usr/bin:/bin:${dirname(process.execPath)}` }), /ENOENT/);
    assert.equal(store.listRuns()[0]?.state, 'failed');
  });
});
