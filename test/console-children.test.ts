import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as processSpawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConsoleController, hostCapabilities } from '../src/console-controller.ts';
import { childTargetId, consoleChildDetail, managedConsoleParent } from '../src/console-children.ts';
import { metaPath, readMeta, readReceipt, readView, sessionDir } from '../src/console-store.ts';
import { createDashboardServer } from '../src/dashboard.ts';
import { DashboardObserver } from '../src/dashboard-observe.ts';
import { spawn } from '../src/spawn.ts';
import { assign, settle, takeUnread } from '../src/mail.ts';
import { ownRun, self } from '../src/identity.ts';
import { runHook } from '../src/hook.ts';
import { resume } from '../src/resume.ts';
import { stopRun } from '../src/retire.ts';
import { processExists } from '../src/console-process.ts';
import { appendMail, listRuns, mailDir, readRun, resultPath, updateRun, writeJson, writeRun } from '../src/store.ts';
import type { ConsoleChildMutation } from '../src/console-types.ts';
import type { RunMeta } from '../src/types.ts';

async function until<T>(read: () => T | false | undefined, timeout = 6000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = read(); if (result) return result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Child fixture condition timed out');
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-child-console-'));
  const prior = { ...process.env };
  for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SESSION', 'CREW_CONSOLE_SESSION']) delete process.env[key];
  Object.assign(process.env, { HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home'), ADVISOR_STATE_DIR: join(root, 'advisor'), CODEX_THREAD_ID: 'before-root' });
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], claude: ['--permission-mode', 'default'] } });
  writeJson(process.env.CREW_ROSTER!, { models: [{ model: 'codex/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }, { model: 'claude/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }] });
  mkdirSync(join(root, 'bin'));
  for (const host of ['codex', 'claude']) {
    const source = resolve(`test/fixtures/console-${host}.ts`);
    const script = `#!${process.execPath}\nimport {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const dir=join(process.env.CREW_HOME,'providers',process.env.CREW_RUN);mkdirSync(dir,{recursive:true});
if(${JSON.stringify(host)}==='codex'){process.env.FAKE_CODEX_LOG=join(dir,'wire.jsonl');process.env.FAKE_CODEX_SCENARIO=join(dir,'scenario.json');if(!existsSync(process.env.FAKE_CODEX_SCENARIO))writeFileSync(process.env.FAKE_CODEX_SCENARIO,JSON.stringify({threadId:'native-'+process.env.CREW_RUN,initialChildRequest:'approval',holdOnStdinClose:true}));}
else{process.env.CLAUDE_FIXTURE_DIR=dir;for(const name of ['input.ndjson','output.ndjson'])if(!existsSync(join(dir,name)))writeFileSync(join(dir,name),'');}
await import(${JSON.stringify(source)});\n`;
    writeFileSync(join(root, 'bin', host), script, { mode: 0o755 });
  }
  writeFileSync(join(root, 'bin', 'herdr'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${prior.PATH}`;
  const processes: ReturnType<typeof processSpawn>[] = [];
  const controller = new ConsoleController({ root, providers: () => [{ id: 'codex', label: 'fixture', available: true, models: [], capabilities: hostCapabilities('codex') }], receiptWaitMs: 3000,
    startSupervisor: async id => {
      const source = resolve(id.startsWith('c-') ? 'src/console-supervisor.ts' : 'test/fixtures/console-supervisor.ts');
      const child = processSpawn(process.execPath, [source, sessionDir(id, root)], { env: { ...process.env }, stdio: 'ignore' });
      processes.push(child); await once(child, 'spawn');
    } });
  const launched = await controller.launch({ requestId: 'root', cwd: root, mode: 'advisor', host: 'codex', access: 'default', prompt: 'hold' });
  const id = launched.session.id;
  process.env.CODEX_THREAD_ID = readMeta(id, root)!.identity!.sessionId;
  const address = self();
  const child = async (host: 'codex' | 'claude', keep = true): Promise<RunMeta> => {
    const run = await spawn({ role: 'builder', task: 'Synthetic isolated packet. No actual work.', cwd: root, keep, model: `${host}/fixture`, effort: 'high' });
    await until(() => readMeta(childTargetId(run.id), root)?.identity?.provider);
    await until(() => ['running', 'waiting'].includes(controller.childDetail(id, run.id)?.child.state ?? ''));
    return readRun(run.id)!;
  };
  const wires = (run: RunMeta) => readFileSync(join(root, 'providers', run.id, run.route.host === 'codex' ? 'wire.jsonl' : 'input.ndjson'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const emit = (run: RunMeta, message: object) => appendFileSync(join(root, 'providers', run.id, 'output.ndjson'), JSON.stringify(message) + '\n');
  const action = (run: RunMeta, action: 'interrupt' | 'resume' | 'stop', requestId = `${action}-${run.id}`) => controller.childAction(id, run.id, { requestId, action, revision: controller.childDetail(id, run.id)!.child.revision });
  const app = createDashboardServer(new DashboardObserver({ crew: root, codex: join(root, 'codex-home'), claude: join(root, 'claude-home') }), 20, controller);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const post = (path: string, body: object) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'X-Crew-Token': controller.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cleanup = async () => {
    app.closeAllConnections(); if (app.listening) await new Promise<void>(r => app.close(() => r()));
    for (const run of listRuns()) await stopRun(run).catch(() => {});
    await controller.action(id, { requestId: 'cleanup', action: 'close', revision: controller.detail(id)!.session.revision }).catch(() => {});
    for (const process of processes) if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM');
    for (const mailbox of readdirSync(join(root, 'mail'))) {
      try { process.kill(Number(readFileSync(join(mailDir(mailbox), 'watcher'), 'utf8')), 'SIGTERM'); } catch { /* only owned temp-state watchers */ }
    }
    process.env = prior; rmSync(root, { recursive: true, force: true });
  };
  return { root, id, address, controller, child, action, emit, wires, origin, post, app, cleanup };
}

test('both managed providers retain child identity and policy; exact native answers isolate child/root and reconcile durable receipts', async () => {
  const f = await fixture();
  try {
    const codex = await f.child('codex'); const claude = await f.child('claude');
    assert.equal(codex.launcher, 'console'); assert.equal(claude.launcher, 'console');
    assert.equal(codex.launch, undefined); // Never persist credential-bearing provider argv.
    assert.equal(ownRun({ CREW_RUN: codex.id }, codex.sessionId)?.id, codex.id);
    assert.equal(ownRun({ CREW_RUN: codex.id }, 'foreign'), undefined);
    const codexLaunch = f.wires(codex)[0];
    assert.equal(codexLaunch.env.CREW_RUN, codex.id);
    assert.ok(codexLaunch.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(codexLaunch.args.includes('approval_policy="on-request"'));
    assert.doesNotMatch(f.wires(codex).find(w => w.method === 'thread/start').params.developerInstructions, /chief of staff|real root/);
    const claudeLaunch = JSON.parse(readFileSync(join(f.root, 'providers', claude.id, 'launched.json'), 'utf8'));
    assert.equal(claudeLaunch.crewRun, claude.id); assert.equal(claudeLaunch.crewMailbox, claude.id);
    assert.deepEqual(claudeLaunch.args.slice(0, 2), ['--permission-mode', 'default']);
    const envFile = join(f.root, 'child.env'); writeFileSync(envFile, '');
    const compact = runHook('session-start', 'claude', JSON.stringify({ session_id: claude.sessionId, source: 'compact', cwd: f.root }), { ...process.env, CREW_RUN: claude.id, CLAUDE_ENV_FILE: envFile });
    assert.match(readFileSync(envFile, 'utf8'), new RegExp(`CREW_MAILBOX=${claude.id}`));
    assert.match(compact, /brief.md/); assert.match(compact, /packet.md/);
    f.emit(claude, { type: 'control_request', request_id: 'allow1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo synthetic' } } });
    const claudeRequest = await until(() => f.controller.childDetail(f.id, claude.id)?.requests[0]);
    const codexRequest = f.controller.childDetail(f.id, codex.id)!.requests[0]!;
    const team = await fetch(`${f.origin}/api/console/sessions/${f.id}/team`).then(r => r.json());
    assert.equal(team.children.length, 2); assert.equal(team.pendingRequests.length, 2);
    assert.equal(f.controller.bootstrap().sessions.length, 1);
    assert.equal(f.controller.detail(childTargetId(codex.id)), undefined);
    await assert.rejects(f.controller.childAnswer(f.id, claude.id, { requestId: 'cross-child', pendingRequestId: codexRequest.id, option: 'accept' }), /no longer pending/);
    await assert.rejects(f.controller.answer(f.id, { requestId: 'cross-root', pendingRequestId: codexRequest.id, option: 'accept' }), /no longer pending/);
    await f.controller.action(f.id, { requestId: 'root-interrupt', action: 'interrupt', revision: f.controller.detail(f.id)!.session.revision });
    assert.equal(f.controller.team(f.id)!.pendingRequests.length, 2);
    const answer = { requestId: 'codex-answer', pendingRequestId: codexRequest.id, option: 'decline' };
    const response = await f.post(`/api/console/sessions/${f.id}/children/${codex.id}/answers`, answer);
    assert.equal(response.status, 200); assert.equal(((await response.json()) as ConsoleChildMutation).command.state, 'delivered');
    assert.equal((await f.controller.childAnswer(f.id, codex.id, answer)).command.state, 'delivered');
    assert.equal(f.wires(codex).filter(w => w.id === 101 && w.result).length, 1);
    await assert.rejects(f.controller.childAnswer(f.id, codex.id, { ...answer, requestId: 'replayed' }), /no longer pending/);
    await assert.rejects(f.controller.childAnswer(f.id, codex.id, { ...answer, option: 'accept' }), /different input/);
    await f.controller.childAnswer(f.id, claude.id, { requestId: 'claude-allow', pendingRequestId: claudeRequest.id, option: 'allow' });
    assert.equal(f.wires(claude).find(w => w.response?.request_id === 'allow1').response.response.behavior, 'allow');
    f.emit(claude, { type: 'control_request', request_id: 'question1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }], multiSelect: false }] } } });
    const question = await until(() => f.controller.childDetail(f.id, claude.id)?.requests[0]);
    await f.controller.childAnswer(f.id, claude.id, { requestId: 'question-answer', pendingRequestId: question.id, answers: { '0': 'Blue' } });
    assert.deepEqual(f.wires(claude).find(w => w.response?.request_id === 'question1').response.response.updatedInput.answers, { 'Which color?': 'Blue' });
    f.emit(claude, { type: 'control_request', request_id: 'deny1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'denied' } } });
    const denied = await until(() => f.controller.childDetail(f.id, claude.id)?.requests[0]);
    await f.controller.childAnswer(f.id, claude.id, { requestId: 'claude-deny', pendingRequestId: denied.id, option: 'deny' });
    assert.equal(f.wires(claude).find(w => w.response?.request_id === 'deny1').response.response.behavior, 'deny');
    const reload = new ConsoleController({ root: f.root });
    assert.equal(reload.childDetail(f.id, codex.id)!.commands!.find(c => c.requestId === answer.requestId)!.state, 'delivered');
    assert.equal((await fetch(`${f.origin}/api/console/sessions/foreign/children/${codex.id}`)).status, 404);
    assert.equal((await f.post(`/api/console/sessions/foreign/children/${codex.id}/answers`, answer)).status, 404);
  } finally { await f.cleanup(); }
});

test('retained child assignment wake uses its run mailbox and same native session; cancellation, resume, stop and root close stay scoped', async () => {
  const f = await fixture();
  try {
    const codex = await f.child('codex'); const claude = await f.child('claude');
    const oldRequest = f.controller.childDetail(f.id, codex.id)!.requests[0]!;
    await f.action(codex, 'interrupt');
    assert.equal(f.controller.childDetail(f.id, codex.id)!.requests.length, 0);
    await assert.rejects(f.controller.childAnswer(f.id, codex.id, { requestId: 'canceled', pendingRequestId: oldRequest.id, option: 'accept' }), /no longer pending/);
    await f.action(codex, 'resume');
    assert.equal(readRun(codex.id)!.sessionId, codex.sessionId);
    assert.equal(f.wires(codex).filter(w => w.method === 'thread/resume').length, 1);
    // Returned results submit the assignment without closing a kept native pipe.
    takeUnread(codex.id);
    writeFileSync(resultPath(codex.id), '# Status\nDONE: synthetic result\n\n# Claims\nSynthetic only.\n');
    settle(codex.id);
    assert.equal(f.controller.childDetail(f.id, codex.id)!.child.assignmentState, 'submitted');
    assign(f.address, codex.id, 'New synthetic assignment.');
    await until(() => f.wires(codex).some(w => w.method === 'turn/start' && w.params.input[0].text.includes('Unread agent mail')));
    assert.equal(readRun(codex.id)!.sessionId, codex.sessionId);
    assert.equal(f.controller.childDetail(f.id, codex.id)!.child.assignmentState, 'active');
    assert.equal(f.wires(codex).filter(w => w.method === 'thread/start').length, 1);
    takeUnread(codex.id);
    const wakeCount = f.wires(codex).filter(w => w.method?.startsWith('turn/') && w.params.input).length;
    await new Promise(r => setTimeout(r, 400));
    assert.equal(f.wires(codex).filter(w => w.method?.startsWith('turn/') && w.params.input).length, wakeCount);
    // CLI resume uses the owned transport, never exec/bg.
    await f.action(codex, 'interrupt', 'interrupt-again');
    assert.equal(await resume(codex.id, true), true);
    assert.equal(readRun(codex.id)!.launcher, 'console');
    const codexProvider = readMeta(childTargetId(codex.id), f.root)!.identity!.provider!;
    await f.action(codex, 'stop');
    assert.equal(processExists(codexProvider.pid), false);
    assert.equal(readRun(codex.id)!.state, 'stopped');
    assert.equal(f.controller.childDetail(f.id, claude.id)!.child.state, 'running');
    const claudeProvider = readMeta(childTargetId(claude.id), f.root)!.identity!.provider!;
    await f.controller.action(f.id, { requestId: 'close-team', action: 'close', revision: f.controller.detail(f.id)!.session.revision });
    assert.equal(processExists(claudeProvider.pid), false); assert.equal(readRun(claude.id)!.state, 'stopped');
    await assert.rejects(f.child('codex'), /retired|disconnected/);
    assert.equal(f.controller.team(f.id)!.pendingRequests.length, 0);
  } finally { await f.cleanup(); }
});

test('env markers never adopt external children; disconnected owned children require explicit recovery and old requests never survive', async () => {
  const f = await fixture();
  try {
    process.env.CREW_CONSOLE_SESSION = f.id;
    assert.equal(managedConsoleParent({ mailbox: 'codex-unrelated', host: 'codex' }), undefined);
    const external: RunMeta = { id: 'b-external', name: 'external', role: 'builder', route: { host: 'codex', model: 'fixture', effort: 'high', strategy: 'pinned' }, cwd: f.root, keep: true,
      parent: f.address, launcher: 'exec', createdAt: new Date().toISOString(), state: 'running', sessionId: 'unmanaged' };
    writeRun(external);
    assert.equal(f.controller.childDetail(f.id, external.id)!.child.managed, false);
    await assert.rejects(f.controller.childAction(f.id, external.id, { requestId: 'adopt', action: 'resume', revision: 0 }), /no console-owned/);
    assert.equal(managedConsoleParent({ mailbox: external.id, host: 'codex' }), undefined);
    const codex = await f.child('claude');
    f.emit(codex, { type: 'control_request', request_id: 'before-loss', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'synthetic' } } });
    const target = childTargetId(codex.id);
    const oldRequest = await until(() => f.controller.childDetail(f.id, codex.id)?.requests[0]);
    const oldOwner = readMeta(target, f.root)!.pid!;
    const oldProvider = readMeta(target, f.root)!.identity!.provider!;
    process.kill(oldOwner, 'SIGKILL');
    await until(() => !processExists(oldOwner));
    appendMail(codex.id, { id: 'lost-owner-mail', at: new Date().toISOString(), from: f.address, kind: 'message', text: 'Advice is not approval.' });
    await assert.rejects(f.controller.childAnswer(f.id, codex.id, { requestId: 'dead-answer', pendingRequestId: oldRequest.id, option: 'accept' }), /disconnected|no longer pending/);
    assert.equal(await resume(codex.id, false), false);
    assert.equal(processExists(oldProvider.pid), true);
    await f.action(codex, 'resume', 'recover-child');
    assert.equal(processExists(oldProvider.pid), false);
    assert.equal(readRun(codex.id)!.sessionId, codex.sessionId);
    await assert.rejects(f.controller.childAnswer(f.id, codex.id, { requestId: 'stale-recovery-answer', pendingRequestId: oldRequest.id, option: 'accept' }), /no longer pending/);
    const resumed = JSON.parse(readFileSync(join(f.root, 'providers', codex.id, 'launched.json'), 'utf8'));
    assert.ok(resumed.args.includes(`--resume=${codex.sessionId}`));
    assert.equal(f.wires(codex).filter(w => w.type === 'user' && w.message.content.startsWith('Read and follow your crew brief:')).length, 1);
  } finally { await f.cleanup(); }
});
