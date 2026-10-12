import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { RunMeta } from '../src/types.ts';

const root = mkdtempSync(join(tmpdir(), 'crew-t3-'));
const bin = join(root, 'bin');
mkdirSync(bin);
const callsFile = join(root, 'calls.jsonl');
const stateFile = join(root, 'bridge-state.json');
const controlFile = join(root, 'bridge-control.json');
const bridgeFile = join(bin, 'bridge.mjs');
const unexpected = join(root, 'unexpected-host');
const secret = 'fixture-private-owner-token';
writeFileSync(bridgeFile, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const request = JSON.parse(args[2]);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, request, authorization: process.env.T3_ACP_MCP_AUTHORIZATION, electron: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const control = read(${JSON.stringify(controlFile)});
if (control.rejectAuthorization === process.env.T3_ACP_MCP_AUTHORIZATION) process.exit(8);
if (control.delayStart && request.action === 'start') {
  fs.writeFileSync(${JSON.stringify(join(root, 'entered'))}, 'yes');
  while (!fs.existsSync(${JSON.stringify(join(root, 'release'))})) await new Promise(resolve => setTimeout(resolve, 5));
}
const all = read(${JSON.stringify(stateFile)});
const metaPath = path.join(process.env.CREW_HOME, 'runs', request.runId, 'meta.json');
const meta = read(metaPath);
let row = all[request.runId] ?? { runId: request.runId, threadId: 'thread-' + request.runId, taskId: 'task-' + request.runId,
  nativeSessionId: 'session-' + request.runId, state: 'idle', starts: 0, resumes: [] };
if (request.action === 'start') {
  if (!fs.existsSync(path.join(path.dirname(metaPath), 'brief.md'))) throw new Error('missing brief');
  if (!row.starts) { row.starts++; row.state = meta.state === 'stopped' ? 'stopped' : 'running'; }
}
if (request.action === 'resume') {
  if (meta.state === 'stopped' || row.state === 'stopped') row.state = 'stopped';
  else if (!row.resumes.includes(request.requestId)) { row.resumes.push(request.requestId); row.state = 'running'; }
}
if (request.action === 'stop') {
  if (process.env.T3_ACP_MCP_AUTHORIZATION === 'expired-grandchild-token') process.exit(8);
  row.state = 'stopped';
  for (const child of Object.values(all)) {
    let current = read(path.join(process.env.CREW_HOME, 'runs', child.runId, 'meta.json'));
    const seen = new Set();
    while (current.parent && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parent.mailbox === request.runId) { child.state = 'stopped'; break; }
      current = read(path.join(process.env.CREW_HOME, 'runs', current.parent.mailbox, 'meta.json'));
    }
  }
}
all[request.runId] = row;
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(all));
if (control.fail === request.action) {
  fs.writeFileSync(${JSON.stringify(controlFile)}, '{}');
  console.error(process.env.T3_ACP_MCP_AUTHORIZATION);
  process.exit(9);
}
const { starts, resumes, ...response } = row;
if (control.wrongIdentity) response.threadId = 'unrelated-thread';
if (control.invalidState) response.state = 'mystery';
if (control.error) console.log(JSON.stringify({ isError: true, content: [{ type: 'text', text: process.env.T3_ACP_MCP_AUTHORIZATION }] }));
else if (control.raw) console.log(JSON.stringify(response));
else if (control.structured) console.log(JSON.stringify({ structuredContent: response }));
else console.log(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(response) }] }));
`, { mode: 0o755 });
for (const command of ['herdr', 'codex', 'claude', 'opencode', 'agent-router']) {
  writeFileSync(join(bin, command), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(unexpected)}, process.argv.join(' ')); process.exit(99);\n`, { mode: 0o755 });
}
Object.assign(process.env, {
  HOME: root, PATH: `${bin}:${process.env.PATH}`, CREW_HOME: join(root, 'crew'),
  CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'),
  CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ADVISOR_STATE_DIR: join(root, 'advisor'),
  CODEX_THREAD_ID: 'root', CREW_NODE: process.execPath, CREW_NO_DELEGATE: '1', HERDR_BIN_PATH: join(bin, 'herdr'),
});
for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_OPENCODE_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_PANE_ID', 'CREW_CODEX_SOCKET', 'CODEX_APP_SERVER_WS_URL']) delete process.env[key];

const store = await import('../src/store.ts');
const { spawn } = await import('../src/spawn.ts');
const { requestResume, resume } = await import('../src/resume.ts');
const { stopRun } = await import('../src/retire.ts');
const { stopRootChildren } = await import('../src/stop-boundary.ts');
const { watch } = await import('../src/wait.ts');
const { finishT3Request, t3Worker } = await import('../src/t3-client.ts');
const calls = (): Array<{ args: string[]; request: { action: string; runId: string; requestId?: string }; authorization: string; electron: string }> =>
  existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const remote = (id: string): Record<string, any> => JSON.parse(readFileSync(stateFile, 'utf8'))[id];
const remoteState = (id: string, state: string): void => {
  const all = JSON.parse(readFileSync(stateFile, 'utf8')); all[id].state = state; store.writeJson(stateFile, all);
};
const preventWatcher = (mailbox: string): void => {
  mkdirSync(store.mailDir(mailbox), { recursive: true });
  writeFileSync(join(store.mailDir(mailbox), 'watcher'), String(process.pid));
};
const launch = (name = 'native-worker', model = 'codex/fixture'): Promise<RunMeta> =>
  spawn({ name, role: 'builder', task: 'Bounded fixture packet, never placed in bridge argv.', cwd: root, keep: true, model });
const mail = (id: string, mailId: string): void => store.appendMail(id, {
  id: mailId, at: new Date().toISOString(), kind: 'message', from: { mailbox: 'codex-root' }, text: 'Read new advice once.',
});

beforeEach(() => {
  for (const path of [store.home(), callsFile, stateFile, controlFile, unexpected, join(root, 'entered'), join(root, 'release')]) rmSync(path, { recursive: true, force: true });
  Object.assign(process.env, { CREWCODE_NATIVE_CREW: '1', T3_ACP_MCP_NODE: process.execPath,
    T3_ACP_MCP_ENTRYPOINT: bridgeFile, T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/fixture', T3_ACP_MCP_AUTHORIZATION: secret,
    T3_CREW_THREAD_ID: 't3-owner', CODEX_THREAD_ID: 'root', CREW_ROUTER: 'off' });
  delete process.env.CREW_RUN;
  delete process.env.CREW_T3_STOP_OWNED;
  delete process.env.CREW_T3_STOP_CONFIRMED;
  delete process.env.CREW_T3_AMEND_OWNED;
  preventWatcher('codex-root');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('native T3 worker lifecycle', () => {
  it('launches through the authenticated bridge with private ownership and public native identity', async () => {
    const run = await launch();
    assert.equal(run.launcher, 't3');
    assert.deepEqual(run.t3, { threadId: `thread-${run.id}`, taskId: `task-${run.id}` });
    assert.equal(run.sessionId, `session-${run.id}`);
    assert.equal(run.t3Request, undefined);
    assert.equal(run.launch?.env.CREW_CONFIG, process.env.CREW_CONFIG);
    assert.equal(run.launch?.env.CREW_ROSTER, process.env.CREW_ROSTER);
    assert.equal(run.launch?.env.CREW_ROUTER, 'off');
    assert.equal(statSync(join(store.runDir(run.id), 't3-bridge.json')).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(run).includes(secret));
    assert.ok(!JSON.stringify(calls()[0]!.args).includes(secret));
    assert.ok(!JSON.stringify(calls()[0]!.args).includes('Bounded fixture'));
    assert.deepEqual(Object.keys(calls()[0]!.request).sort(), ['action', 'requestId', 'runId']);
    assert.equal(calls()[0]!.electron, '1');
    assert.equal(existsSync(unexpected), false);
  });

  it('supports a standalone bridge executable and fails closed on missing transport or unsupported host', async () => {
    delete process.env.T3_ACP_MCP_AUTHORIZATION;
    await assert.rejects(launch(), /bridge is unavailable/);
    assert.deepEqual(store.listRuns(), []);
    process.env.T3_ACP_MCP_AUTHORIZATION = secret;
    await assert.rejects(launch('unsupported', 'opencode/fixture'), /support Codex and Claude only/);
    delete process.env.T3_ACP_MCP_ENTRYPOINT;
    process.env.T3_ACP_MCP_NODE = bridgeFile;
    store.writeJson(controlFile, { structured: true });
    const run = await launch('standalone', 'claude/fixture');
    assert.equal(run.route.host, 'claude');
    assert.equal(run.launcher, 't3');
    assert.equal(existsSync(unexpected), false);
  });

  it('uses saved owner credentials outside the original root and rejects changed response ownership', async () => {
    const run = await launch();
    process.env.T3_ACP_MCP_AUTHORIZATION = 'unrelated-root-token';
    process.env.T3_CREW_THREAD_ID = 'another-owner';
    store.writeJson(controlFile, { raw: true });
    await t3Worker(run, 'status');
    assert.equal(calls().at(-1)!.authorization, secret);
    store.writeJson(controlFile, { wrongIdentity: true });
    await assert.rejects(t3Worker(run, 'status'), /ownership changed/);
    assert.deepEqual(store.readRun(run.id)?.t3, run.t3);
    store.writeJson(controlFile, { error: true });
    await assert.rejects(t3Worker(run, 'status'), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(secret)); return true;
    });
    store.writeJson(controlFile, { invalidState: true });
    await assert.rejects(t3Worker(run, 'status'), /invalid T3 worker identity/);
  });

  it('refreshes rotated credentials only for the exact owning native thread and endpoint', async () => {
    const run = await launch();
    process.env.T3_ACP_MCP_AUTHORIZATION = 'rotated-owner-token';
    await t3Worker(run, 'status');
    assert.equal(calls().at(-1)!.authorization, 'rotated-owner-token');
    assert.equal(store.readJson<Record<string, string>>(join(store.runDir(run.id), 't3-bridge.json'))?.T3_ACP_MCP_AUTHORIZATION, 'rotated-owner-token');
    process.env.T3_ACP_MCP_AUTHORIZATION = secret; // an old watcher survived the root's token rotation
    store.writeJson(controlFile, { rejectAuthorization: secret });
    await t3Worker(run, 'status');
    assert.equal(calls().at(-1)!.authorization, 'rotated-owner-token');
    assert.equal(store.readJson<Record<string, string>>(join(store.runDir(run.id), 't3-bridge.json'))?.T3_ACP_MCP_AUTHORIZATION, 'rotated-owner-token');
    store.writeJson(controlFile, {});
    process.env.T3_ACP_MCP_ENDPOINT = 'http://127.0.0.1:2/another-server';
    process.env.T3_ACP_MCP_AUTHORIZATION = 'different-server-token';
    await t3Worker(run, 'status');
    assert.equal(calls().at(-1)!.authorization, 'rotated-owner-token');
  });

  it('rejects a changed native session in status without overwriting the child hook identity', async () => {
    const run = await launch();
    const all = JSON.parse(readFileSync(stateFile, 'utf8'));
    all[run.id].nativeSessionId = 'unrelated-native-session';
    store.writeJson(stateFile, all);
    await assert.rejects(t3Worker(run, 'status'), /native session ownership changed/);
    assert.equal(store.readRun(run.id)?.sessionId, run.sessionId);
  });

  it('retries an uncertain start without creating another child', async () => {
    store.writeJson(controlFile, { fail: 'start' });
    await assert.rejects(launch(), /T3 start failed/);
    const run = store.listRuns()[0]!;
    assert.equal(run.state, 'failed');
    const requestId = run.t3Request?.requestId;
    assert.ok(requestId);
    assert.equal(await resume(run.id, true), true);
    assert.equal(remote(run.id).starts, 1);
    assert.deepEqual(calls().filter(call => call.request.action === 'start').map(call => call.request.requestId), [requestId, requestId]);
    assert.equal(store.readRun(run.id)?.t3Request, undefined);
    assert.equal(existsSync(unexpected), false);
  });

  it('resumes the same child once per mail batch, with idempotent retry and a fresh key for later mail', async () => {
    const run = await launch();
    mail(run.id, 'mail-one');
    assert.equal(await resume(run.id), false); // busy native turn cannot be cloned
    remoteState(run.id, 'waiting');
    assert.equal(await resume(run.id), false); // agent mail cannot answer an approval
    remoteState(run.id, 'idle');
    store.writeJson(controlFile, { fail: 'resume' });
    await assert.rejects(resume(run.id), /T3 resume failed/);
    assert.equal(store.readRun(run.id)?.resumedMail, undefined);
    const requestId = store.readRun(run.id)?.t3Request?.requestId;
    assert.ok(requestId);
    assert.equal(await resume(run.id), true);
    assert.equal(store.readRun(run.id)?.resumedMail, 'mail-one');
    assert.equal(await resume(run.id), false);
    mail(run.id, 'mail-two');
    remoteState(run.id, 'idle');
    assert.equal(await resume(run.id), true);
    assert.equal(remote(run.id).resumes.length, 2);
    assert.notEqual(remote(run.id).resumes[1], requestId);
    assert.deepEqual(store.readRun(run.id)?.t3, run.t3);
  });

  it('reports native approval waits once and settles a completed packet through the parent watcher', async () => {
    const run = await launch();
    remoteState(run.id, 'waiting');
    await watch('codex-root', 1, 100);
    await watch('codex-root', 1, 100);
    const notices = store.unread('codex-root').mails.filter(item => item.kind === 'waiting');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /CrewCode/);
    assert.ok(store.readRun(run.id)?.waitingSince);
    writeFileSync(store.resultPath(run.id), '# Status\nDONE\n\n# Changes\nFixture complete.\n\n# Verification\nPassed.\n\n# Risks\nNone.\n');
    remoteState(run.id, 'idle');
    await watch('codex-root', 1, 100);
    assert.equal(store.readRun(run.id)?.state, 'idle'); // retained workers keep their identity
    assert.equal(store.unread('codex-root').mails.filter(item => item.kind === 'settled').length, 1);
  });

  it('stops exact nested ancestry, preserves peers, retries failed stops, and never revives a stopped run', async () => {
    const parent = await launch('advisor');
    preventWatcher(parent.id);
    process.env.CREW_RUN = parent.id;
    process.env.CODEX_THREAD_ID = parent.sessionId;
    const child = await launch('nested');
    const childBridgePath = join(store.runDir(child.id), 't3-bridge.json');
    store.writeJson(childBridgePath, { ...store.readJson<Record<string, string>>(childBridgePath),
      T3_CREW_THREAD_ID: parent.t3!.threadId, T3_ACP_MCP_AUTHORIZATION: 'expired-grandchild-token' });
    delete process.env.CREW_RUN;
    process.env.CODEX_THREAD_ID = 'peer';
    preventWatcher('codex-peer');
    const peer = await launch('peer');
    store.writeJson(controlFile, { fail: 'stop' });
    await assert.rejects(stopRootChildren('codex-root'), /retry stop/);
    assert.ok(existsSync(join(store.runDir(child.id), 't3-bridge.json')));
    assert.equal(store.readRun(parent.id)?.t3Stopped, undefined);
    await stopRootChildren('codex-root');
    assert.equal(remote(parent.id).state, 'stopped');
    assert.equal(remote(child.id).state, 'stopped');
    assert.equal(remote(peer.id).state, 'running');
    assert.equal(calls().filter(call => call.request.action === 'stop' && call.request.runId === child.id).length, 0);
    assert.equal(existsSync(join(store.runDir(parent.id), 't3-bridge.json')), false);
    assert.equal(existsSync(join(store.runDir(child.id), 't3-bridge.json')), false);
    assert.ok(existsSync(join(store.runDir(peer.id), 't3-bridge.json')));
    await assert.rejects(resume(parent.id, true), /is stopped/);
    assert.equal(calls().filter(call => call.request.action === 'resume').length, 0);
  });

  it('fences a delayed native start and supports CrewCode-owned stop without an expired bridge call', async () => {
    store.writeJson(controlFile, { delayStart: true });
    const pending = launch();
    const deadline = Date.now() + 3000;
    while (!existsSync(join(root, 'entered'))) {
      assert.ok(Date.now() < deadline, 'fake bridge start entered');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    process.env.CREW_T3_STOP_OWNED = '1';
    await stopRootChildren('codex-root');
    const fenced = store.listRuns()[0]!;
    assert.equal(fenced.state, 'stopped');
    assert.equal(fenced.t3Stopped, undefined);
    assert.ok(existsSync(join(store.runDir(fenced.id), 't3-bridge.json')));
    writeFileSync(join(root, 'release'), 'yes');
    const run = await pending;
    assert.equal(run.state, 'stopped');
    assert.equal(remote(run.id).state, 'stopped');
    assert.equal(calls().filter(call => call.request.action === 'stop').length, 0);
    await stopRun(run);
    assert.equal(calls().filter(call => call.request.action === 'stop').length, 0);
    assert.equal(existsSync(unexpected), false);
  });

  it('keeps owned Stop retryable until the native service explicitly confirms quiescence', async () => {
    const run = await launch();
    process.env.CREW_T3_STOP_OWNED = '1';
    await stopRun(run);
    assert.equal(store.readRun(run.id)?.state, 'stopped');
    assert.equal(store.readRun(run.id)?.t3Stopped, undefined);
    assert.ok(existsSync(join(store.runDir(run.id), 't3-bridge.json')));
    assert.equal(remote(run.id).state, 'running');
    assert.equal((await t3Worker(store.readRun(run.id)!, 'status')).state, 'running');
    delete process.env.CREW_T3_STOP_OWNED;
    await stopRun(store.readRun(run.id)!); // a failed native UI stop can still retry through the bridge
    assert.equal(remote(run.id).state, 'stopped');
    assert.equal(store.readRun(run.id)?.t3Stopped, true);
    assert.equal(existsSync(join(store.runDir(run.id), 't3-bridge.json')), false);

    const confirmed = await launch('confirmed-worker');
    process.env.CREW_T3_STOP_OWNED = '1';
    await stopRun(confirmed);
    remoteState(confirmed.id, 'stopped'); // native owner has now proved its cancellation
    process.env.CREW_T3_STOP_CONFIRMED = '1';
    await stopRun(store.readRun(confirmed.id)!);
    assert.equal(store.readRun(confirmed.id)?.t3Stopped, true);
    assert.equal(existsSync(join(store.runDir(confirmed.id), 't3-bridge.json')), false);
    assert.equal(calls().filter(call => call.request.runId === confirmed.id && call.request.action === 'stop').length, 0);
  });

  it('records native composer input as one durable amendment without launching a duplicate turn', async () => {
    const run = await launch();
    const textFile = join(root, 'composer.txt');
    writeFileSync(textFile, 'Change the outcome to include the native check.');
    const args = ['t3-amend', run.id, '--request-id', 'human-message-one', '--text-file', textFile];
    assert.throws(() => execFileSync(resolve('bin/crew'), args, { env: process.env, stdio: 'pipe' }), /server-owned native composer/);
    const env = { ...process.env, CREW_T3_AMEND_OWNED: '1' };
    const first = execFileSync(resolve('bin/crew'), args, { env, encoding: 'utf8' });
    const again = execFileSync(resolve('bin/crew'), args, { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(first), { runId: run.id, number: 1 });
    assert.equal(again, first);
    assert.equal((readFileSync(store.packetPath(run.id), 'utf8').match(/## Amendment/g) ?? []).length, 1);
    assert.equal(store.unread(run.id).mails.length, 1);
    assert.equal(store.readRun(run.id)?.assignment?.revision, 1);
    assert.equal(requestResume(store.readRun(run.id)!), false);
    assert.equal(calls().filter(call => call.request.action === 'resume').length, 0);
    const coveredMail = store.readRun(run.id)?.resumedMail;
    store.updateRun(run.id, current => ({ ...current, t3Request: { action: 'resume', requestId: 'older-resume', mailId: 'older-mail' } }));
    finishT3Request(run.id, 'older-resume');
    assert.equal(store.readRun(run.id)?.resumedMail, coveredMail);
    writeFileSync(textFile, 'Different text cannot reuse the original request ID.');
    assert.throws(() => execFileSync(resolve('bin/crew'), args, { env, stdio: 'pipe' }), /reused with different text/);
    assert.equal(store.readRun(run.id)?.assignment?.revision, 1);
    await stopRun(run);
    assert.throws(() => execFileSync(resolve('bin/crew'), args, { env, stdio: 'pipe' }), /is stopped/);
  });
});
