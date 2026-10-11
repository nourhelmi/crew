import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { hash, scoreCapture, scoreTinyCapture, tinyInstructions, tinyVerifier } from '../evals/capture.ts';
import type { Assignment, LiveCapture, Receipt, Run } from '../evals/capture.ts';
import { fixture, runFixtures } from '../evals/fixtures.ts';
import { isolatedEnv, runLive, sanitizer } from '../evals/live.ts';
import { scenarios } from '../evals/scenarios.ts';
import { score } from '../evals/score.ts';

const tool = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, command: 'node verify.mjs' } });
const thread = (id: string) => JSON.stringify({ type: 'thread.started', thread_id: id });
function capture(): LiveCapture {
  const files: Record<string, string> = {};
  const assignment = (run: string, id: string): Assignment => {
    const result = `crew/runs/${run}/submissions/${id}.md`;
    files[result] = `# Status\nDONE: ${id}\n# Evidence\nverified artifact\n`;
    const ref = `${id}-r0-${hash(files[result]).slice(0, 16)}`;
    return { id, revision: 0, status: 'accepted', submission: ref, submissions: [{ ref, result, hash: hash(files[result]).slice(0, 16), revision: 0 }], accepted: { submission: ref, by: 'codex-root' } };
  };
  const stock: Run = { id: 'a-stock', role: 'advisor', keep: true, state: 'idle', sessionId: 'session-stock', parent: { mailbox: 'codex-root' }, assignment: assignment('a-stock', 'receipt'), assignmentHistory: [assignment('a-stock', 'initial')] };
  const sales: Run = { id: 'a-sales', role: 'advisor', keep: true, state: 'idle', sessionId: 'session-sales', parent: { mailbox: 'codex-root' }, assignment: assignment('a-sales', 'initial') };
  files['workspace/stock/summary.json'] = JSON.stringify({ owner: stock.id, tea: 9, coffee: 3 });
  files['workspace/sales/summary.json'] = JSON.stringify({ owner: sales.id, grossCents: 1700, orders: 3 });
  files['workspace/release.json'] = JSON.stringify({ tea: 9, coffee: 3, grossCents: 1700, orders: 3 });
  const receipts: Receipt[] = [stock, sales].flatMap(run => [run.assignment!, ...(run.assignmentHistory ?? [])].map(a => ({ args: ['accept', run.id, a.submission!], caller: 'codex-root', exitCode: 0, stdout: 'accepted', before: {} })));
  const before = { ...files };
  before['workspace/stock/summary.json'] = JSON.stringify({ owner: stock.id, tea: 7, coffee: 3 });
  receipts.push({ args: ['assign', stock.id, '--packet', 'receipt.md'], caller: 'codex-root', exitCode: 0, stdout: 'new assignment', before });
  for (const [run, path, previous, after] of [
    [stock, 'workspace/stock/summary.json', undefined, before['workspace/stock/summary.json']],
    [stock, 'workspace/stock/summary.json', before['workspace/stock/summary.json'], files['workspace/stock/summary.json']],
    [sales, 'workspace/sales/summary.json', undefined, files['workspace/sales/summary.json']],
  ] as const) receipts.push({ args: ['codex', 'exec'], caller: run.id, exitCode: 0, stdout: '',
    before: previous === undefined ? {} : { [path]: previous }, after: { [path]: after! } });
  return { runs: [stock, sales], files, receipts, rootTranscript: tool, childTranscripts: {
    [stock.id]: [thread(stock.sessionId!), tool, thread(stock.sessionId!), tool].join('\n'),
    [sales.id]: [thread(sales.sessionId!), tool].join('\n'),
  } };
}
const fails = (value: LiveCapture, id: string) => assert.equal(scoreCapture(value, 'fixture-model', 0).cases[0]!.assertions.find(a => a.id === id)?.status, 'fail');

describe('behavior eval proof boundaries and scorer counterexamples', () => {
  it('runs every positive, negative and missing-evidence fixture without provider launches', () => {
    const report = runFixtures();
    assert.equal(report.status, 'pass'); assert.equal(report.proof, 'scorer-fixtures-only');
    assert.equal(report.model, null); assert.equal(report.launchCount, 0);
    assert.equal(report.cases.length, scenarios.length);
    const observation = fixture(scenarios[0]);
    delete observation.facts['integrated-output'];
    assert.equal(score(observation).status, 'not-executed');
  });
  it('accepts independently captured exact refs, tools, artifacts and retained identity', () => {
    const report = scoreCapture(capture(), 'fixture-model', 100);
    assert.equal(report.status, 'pass'); assert.equal(report.launchCount, 2);
    assert.ok(report.cases.slice(1).every(c => c.status === 'not-executed'));
  });
  it('does not trust a reported PASS, receipts without successful tools or plan JSON', () => {
    const value = capture(); value.rootTranscript = JSON.stringify({ status: 'PASS', plan: ['spawn', 'accept'] });
    fails(value, 'independent-advisors');
    value.childTranscripts = { 'a-stock': 'PASS', 'a-sales': 'PASS' };
    fails(value, 'advisor-artifacts');
  });
  it('rejects incorrect integrated data and a single owner claiming both domains', () => {
    const value = capture(); value.files['workspace/release.json'] = '{"tea":900}'; fails(value, 'integrated-output');
    value.files['workspace/sales/summary.json'] = JSON.stringify({ owner: 'a-stock', grossCents: 1700, orders: 3 });
    fails(value, 'advisor-artifacts');
  });
  it('requires artifact-producing owner turns rather than passive advisor tool events', () => {
    const value = capture();
    value.receipts = value.receipts.filter(r => !(r.args[0] === 'codex' && r.caller === 'a-stock'));
    value.childTranscripts['a-stock'] = [thread('session-stock'), JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, command: 'true' } })].join('\n');
    assert.equal(scoreCapture(value, 'fixture-model', 0).status, 'fail');
  });
  it('rejects stale refs, changed bytes, wrong parent and grade-only acceptance', () => {
    for (const mutate of [
      (v: LiveCapture) => { v.runs[0]!.assignment!.revision++; },
      (v: LiveCapture) => { v.runs[0]!.assignment!.submission = 'older-ref'; },
      (v: LiveCapture) => { v.files[v.runs[0]!.assignment!.submissions[0]!.result] += 'rewritten'; },
      (v: LiveCapture) => { v.receipts[0]!.caller = 'codex-stranger'; },
      (v: LiveCapture) => { v.receipts = v.receipts.filter(r => r.args[0] !== 'accept'); },
    ]) { const value = capture(); mutate(value); fails(value, 'exact-acceptance'); }
  });
  it('requires pre-assign bytes and the same retained provider session', () => {
    const value = capture();
    value.childTranscripts['a-stock'] += '\n' + thread('new-session'); fails(value, 'retained-reuse');
    value.receipts.find(r => r.args[0] === 'assign')!.before = {}; fails(value, 'immutable-prior-result');
  });
  it('rejects abandoned descendants and pending assignment acceptance', () => {
    const value = capture(); value.runs[0]!.state = 'running'; fails(value, 'descendants-settled');
  });
  it('tiny repair requires the immutable verifier, bounded files, and actual execution', () => {
    const value: LiveCapture = { runs: [], receipts: [], rootTranscript: tool, childTranscripts: {}, files: {
      'workspace/greeting.json': '{"message":"Hello world"}', 'workspace/verify.mjs': tinyVerifier, 'workspace/AGENTS.md': tinyInstructions,
    } };
    value.receipts.push({ args: ['node', 'verify.mjs'], caller: 'codex-root', exitCode: 0, stdout: 'greeting verified',
      cwd: 'workspace', before: { ...value.files }, after: { ...value.files } });
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'pass');
    value.files['workspace/verify.mjs'] = 'console.log("PASS")';
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail');
    value.files['workspace/verify.mjs'] = tinyVerifier; value.rootTranscript = 'PASS';
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail');
  });

  it('does not count echoed verifier commands or a verifier run on different bytes', () => {
    const value: LiveCapture = { runs: [], receipts: [], childTranscripts: {}, files: {
      'workspace/greeting.json': '{"message":"Hello world"}', 'workspace/verify.mjs': tinyVerifier, 'workspace/AGENTS.md': tinyInstructions,
    }, rootTranscript: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, command: 'echo node verify.mjs' } }) };
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail');
    value.rootTranscript = tool;
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail', 'transcript command text is insufficient');
    value.receipts.push({ args: ['node', 'verify.mjs'], caller: 'codex-root', exitCode: 0, stdout: '', cwd: 'workspace',
      before: { ...value.files, 'workspace/greeting.json': '{"message":"old"}' }, after: { ...value.files } });
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail', 'verifier must execute on delivered bytes');
    value.receipts[0]!.before = { ...value.files };
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'pass');
    value.receipts[0]!.args = ['node', '-e', 'true', 'verify.mjs'];
    assert.equal(scoreTinyCapture(value, 'fixture-model', 0).status, 'fail');
  });
});

describe('isolated live adapter without real auth or hosts', () => {
  it('allowlists environment and scrubs known credentials and common token forms', () => {
    const env = isolatedEnv('/tmp/synthetic', { PATH: '/usr/bin', CREW_RUN: 'real', CREW_CODEX_SOCKET: '/real.sock', HERDR_ENV: '1', CODEX_THREAD_ID: 'real', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'real-hook' });
    for (const key of ['CREW_RUN', 'CREW_CODEX_SOCKET', 'HERDR_ENV', 'CODEX_THREAD_ID', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
    assert.equal(env.HOME, '/tmp/synthetic/home'); assert.equal(env.CREW_NO_DELEGATE, '1');
    const clean = sanitizer('{"tokens":{"access_token":"test-secret-value"}}')('test-secret-value Bearer opaque-token sk-test123456789 {"refresh_token":"other-token"}');
    for (const secret of ['test-secret-value', 'opaque-token', 'sk-test123456789', 'other-token']) assert.ok(!clean.includes(secret));
  });
  it('reports missing auth as blocked rather than model PASS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-eval-test-'));
    try {
      const { report } = await runLive({ case: 'advisor-tiny-repair', model: 'fixture', timeoutMs: 100, out: dir });
      assert.equal(report.status, 'blocked'); assert.equal(report.launchCount, 0);
      assert.match(report.note, /Missing explicit/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects symlink auth sources without reading personal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-eval-test-'));
    try {
      writeFileSync(join(dir, 'fake-auth.json'), '{"tokens":{"access_token":"synthetic-only"}}');
      symlinkSync(join(dir, 'fake-auth.json'), join(dir, 'link.json'));
      const { report } = await runLive({ case: 'advisor-tiny-repair', model: 'fixture', timeoutMs: 100, out: dir, authFile: join(dir, 'link.json'), codexBin: '/unused' });
      assert.equal(report.status, 'blocked'); assert.match(report.note, /symlink/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('captures a fake-host adapter run, sanitizes traces, and removes copied auth/home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-eval-test-'));
    try {
      const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-secret-token"}}');
      const host = join(dir, 'fake-codex');
      writeFileSync(host, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');
if(process.argv[2]==='login')process.exit(0);
fs.writeFileSync(${JSON.stringify(join(dir, 'sandbox-locator'))},process.env.HOME);
if((fs.statSync(p.join(process.env.CODEX_HOME,'auth.json')).mode&0o777)!==0o600)process.exit(9);
const cwd=process.argv[process.argv.indexOf('-C')+1];
for(const setting of ['approval_policy="never"','sandbox_workspace_write.network_access=true'])if(!process.argv.includes(setting))process.exit(8);
if(process.argv[process.argv.indexOf('-s')+1]!=='workspace-write')process.exit(8);
fs.writeFileSync(p.join(cwd,'greeting.json'),JSON.stringify({message:'Hello world'}));
cp.execFileSync('node',['verify.mjs'],{cwd});
console.log(${JSON.stringify(tool)});console.log('synthetic-secret-token');\n`, { mode: 0o700 });
      const { report, directory } = await runLive({ case: 'advisor-tiny-repair', model: 'fixture', timeoutMs: 3000, out: join(dir, 'results'), authFile: auth, codexBin: host });
      // Fake provider tests adapter mechanics only, never claim real-model behavior.
      assert.equal(report.status, 'pass', JSON.stringify(report));
      assert.ok(!readFileSync(join(directory, 'root.jsonl'), 'utf8').includes('synthetic-secret-token'));
      assert.equal(statSync(join(directory, 'report.json')).mode & 0o777, 0o600);
      const sandboxHome = readFileSync(join(dir, 'sandbox-locator'), 'utf8');
      assert.throws(() => statSync(sandboxHome), /ENOENT/);
      assert.deepEqual(readdirSync(dir).sort(), ['fake-auth.json', 'fake-codex', 'results', 'sandbox-locator']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('kills its owned group on timeout, saves evidence, and removes copied credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-eval-test-'));
    try {
      const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-only"}}');
      const host = join(dir, 'fake-codex');
      writeFileSync(host, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='login')process.exit(0);
fs.writeFileSync(${JSON.stringify(join(dir, 'sandbox-locator'))},JSON.stringify({home:process.env.HOME,pid:process.pid}));
process.on('SIGTERM',()=>{});setInterval(()=>{},100);\n`, { mode: 0o700 });
      const { report, directory } = await runLive({ case: 'advisor-tiny-repair', model: 'fixture', timeoutMs: 500, out: join(dir, 'results'), authFile: auth, codexBin: host });
      assert.equal(report.status, 'fail'); assert.match(report.note, /Timed out/);
      assert.ok(readFileSync(join(directory, 'report.json'), 'utf8').includes('Timed out'));
      const { home, pid } = JSON.parse(readFileSync(join(dir, 'sandbox-locator'), 'utf8'));
      assert.throws(() => statSync(home), /ENOENT/);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('escalates interruption cleanup independently of a long workflow timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-eval-test-'));
    try {
      const auth = join(dir, 'fake-auth.json'); writeFileSync(auth, '{"tokens":{"access_token":"synthetic-only"}}');
      const locator = join(dir, 'sandbox-locator'); const host = join(dir, 'fake-codex');
      writeFileSync(host, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='login')process.exit(0);
process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(locator)},JSON.stringify({home:process.env.HOME,pid:process.pid}));setInterval(()=>{},100);\n`, { mode: 0o700 });
      const started = Date.now();
      const pending = runLive({ case: 'advisor-tiny-repair', model: 'fixture', timeoutMs: 4500, out: join(dir, 'results'), authFile: auth, codexBin: host });
      for (let attempts = 0; attempts < 100; attempts++) {
        try { statSync(locator); break; } catch { await delay(20); }
      }
      process.emit('SIGINT');
      const { report } = await pending;
      assert.match(report.note, /Interrupted/);
      assert.ok(Date.now() - started < 3000, 'interrupt must not wait for the workflow timeout');
      const { home, pid } = JSON.parse(readFileSync(locator, 'utf8'));
      assert.throws(() => statSync(home), /ENOENT/); assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
