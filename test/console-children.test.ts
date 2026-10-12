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
import { assign, settle, takeUnread, waiting } from '../src/mail.ts';
import { ownRun, self } from '../src/identity.ts';
import { runHook } from '../src/hook.ts';
import { resume } from '../src/resume.ts';
import { stopRun } from '../src/retire.ts';
import { processExists } from '../src/console-process.ts';
import { setSessionRouter } from '../src/settings.ts';
import { appendMail, listRuns, mailDir, markWaiter, readRun, resultPath, unread, updateRun, writeJson, writeRun } from '../src/store.ts';
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
  for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_ROUTER', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SESSION', 'CREW_CONSOLE_SESSION']) delete process.env[key];
  Object.assign(process.env, { HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home'), ADVISOR_STATE_DIR: join(root, 'advisor'), CODEX_THREAD_ID: 'before-root' });
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], claude: ['--permission-mode', 'default'] } });
  writeJson(process.env.CREW_ROSTER!, { models: [{ model: 'codex/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }, { model: 'claude/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }, { model: 'opencode/fixture', effort: 'high', roles: ['builder'], cost: 0, use: 'test' }] });
  mkdirSync(join(root, 'bin'));
  for (const host of ['codex', 'claude']) {
    const source = resolve(`test/fixtures/console-${host}.ts`);
    const script = `#!${process.execPath}\nimport {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const dir=join(process.env.CREW_HOME,'providers',process.env.CREW_RUN);mkdirSync(dir,{recursive:true});
if(${JSON.stringify(host)}==='codex'){process.env.FAKE_CODEX_LOG=join(dir,'wire.jsonl');process.env.FAKE_CODEX_SCENARIO=join(dir,'scenario.json');if(!existsSync(process.env.FAKE_CODEX_SCENARIO))writeFileSync(process.env.FAKE_CODEX_SCENARIO,JSON.stringify({threadId:'native-'+process.env.CREW_RUN,initialChildRequest:'approval',holdOnStdinClose:true,initializeDelayMs:Number(process.env.CHILD_FIXTURE_DELAY||0)}));}
else{process.env.CLAUDE_FIXTURE_DIR=dir;for(const name of ['input.ndjson','output.ndjson'])if(!existsSync(join(dir,name)))writeFileSync(join(dir,name),'');}
await import(${JSON.stringify(source)});\n`;
    writeFileSync(join(root, 'bin', host), script, { mode: 0o755 });
  }
  writeFileSync(join(root, 'bin', 'herdr'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'opencode'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';import {join} from 'node:path';
writeFileSync(join(process.env.CREW_HOME,'opencode-launch.json'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),run:process.env.CREW_RUN,home:process.env.CREW_HOME}));setInterval(()=>{},1000);\n`, { mode: 0o755 });
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
  // The root is held while a foreground reader inspects child waiting notices.
  // Otherwise a synthetic 70ms mail turn can finish between revision capture and interrupt.
  const unmarkRoot = markWaiter(f.address.mailbox);
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
    waiting(codex.id, true);
    const attention = unread(f.address.mailbox).mails.find(mail => mail.kind === 'waiting' && mail.from.mailbox === codex.id);
    assert.match(attention!.text, /Crew console/); assert.doesNotMatch(attention!.text, /herdr pane|claude attach/);
    const team = await fetch(`${f.origin}/api/console/sessions/${f.id}/team`).then(r => r.json());
    assert.equal(team.children.length, 2); assert.equal(team.pendingRequests.length, 2);
    assert.equal(f.controller.bootstrap().sessions.length, 1);
    assert.equal(f.controller.detail(childTargetId(codex.id)), undefined);
    await assert.rejects(f.controller.childAnswer(f.id, claude.id, { requestId: 'cross-child', pendingRequestId: codexRequest.id, option: 'accept' }), /no longer pending/);
    await assert.rejects(f.controller.answer(f.id, { requestId: 'cross-root', pendingRequestId: codexRequest.id, option: 'accept' }), /no longer pending/);
    const root = f.controller.detail(f.id)!.session;
    assert.equal(root.state, 'running');
    const interrupted = await f.controller.action(f.id, { requestId: 'root-interrupt', action: 'interrupt', revision: root.revision });
    assert.equal(interrupted.command.state, 'delivered'); assert.equal(interrupted.session.state, 'interrupted');
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
  } finally { unmarkRoot(); await f.cleanup(); }
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

test('a blocked native answer cannot block another child; stop cancels the in-flight decision without replay', async () => {
  const f = await fixture();
  try {
    const slow = await f.child('codex'); const fast = await f.child('claude');
    const scenario = join(f.root, 'providers', slow.id, 'scenario.json');
    writeJson(scenario, { ...JSON.parse(readFileSync(scenario, 'utf8')), holdAnswers: true });
    const pending = f.controller.childDetail(f.id, slow.id)!.requests[0]!;
    const answering = f.controller.childAnswer(f.id, slow.id, { requestId: 'slow-answer', pendingRequestId: pending.id, option: 'accept' });
    await until(() => readReceipt(childTargetId(slow.id), 'slow-answer', f.root)?.phase === 'attempted');
    f.emit(fast, { type: 'control_request', request_id: 'fast-answer', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'synthetic' } } });
    const request = await until(() => f.controller.childDetail(f.id, fast.id)?.requests[0]);
    const start = Date.now();
    const result = await f.controller.childAnswer(f.id, fast.id, { requestId: 'fast-answer', pendingRequestId: request.id, option: 'deny' });
    assert.equal(result.command.state, 'delivered'); assert.ok(Date.now() - start < 2000);
    await stopRun(readRun(slow.id)!);
    const ambiguous = await answering;
    assert.equal(ambiguous.command.state, 'uncertain');
    assert.equal(f.wires(slow).filter(w => w.result?.decision === 'accept').length, 1);
    assert.equal(f.controller.childDetail(f.id, slow.id)!.requests.length, 0);
    assert.equal(f.controller.childDetail(f.id, fast.id)!.child.state, 'running');
  } finally { await f.cleanup(); }
});

test('nested children keep verified ancestry; root close waits for an in-flight launch and blocks descendants from stopped parents', async () => {
  const f = await fixture();
  try {
    const advisor = await f.child('codex');
    process.env.CREW_RUN = advisor.id; process.env.CODEX_THREAD_ID = advisor.sessionId;
    const nested = await f.child('claude');
    assert.equal(nested.parent.mailbox, advisor.id);
    assert.equal(f.controller.childDetail(f.id, nested.id)!.child.parentRunId, advisor.id);
    assert.equal(nested.console!.rootSessionId, f.id);
    delete process.env.CREW_RUN; process.env.CODEX_THREAD_ID = readMeta(f.id, f.root)!.identity!.sessionId;
    process.env.CHILD_FIXTURE_DELAY = '500';
    const late = await spawn({ role: 'builder', task: 'Synthetic delayed launch.', cwd: f.root, keep: true, model: 'codex/fixture', effort: 'high' });
    delete process.env.CHILD_FIXTURE_DELAY;
    await until(() => readMeta(childTargetId(late.id), f.root)?.pid);
    await f.controller.action(f.id, { requestId: 'close-nested-team', action: 'close', revision: f.controller.detail(f.id)!.session.revision });
    for (const run of [advisor, nested, late]) {
      assert.equal(readRun(run.id)!.state, 'stopped');
      const provider = readMeta(childTargetId(run.id), f.root)?.identity?.provider;
      if (provider) assert.equal(processExists(provider.pid), false);
      assert.equal(f.controller.childDetail(f.id, run.id)!.requests.length, 0);
    }
    const lateLog = join(f.root, 'providers', late.id, 'wire.jsonl');
    try { assert.equal(readFileSync(lateLog, 'utf8').split('\n').filter(Boolean).map(v => JSON.parse(v)).filter(v => v.method === 'turn/start').length, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // Pre-start cancellation launches no provider.
    process.env.CREW_RUN = advisor.id; process.env.CODEX_THREAD_ID = advisor.sessionId;
    await assert.rejects(f.child('codex'), /retired|stopped|disconnected/);
  } finally { await f.cleanup(); }
});

test('resume preserves policy, active Claude mail waits for idle and interrupted mail requires explicit continuation', async () => {
  const f = await fixture();
  try {
    const claude = await f.child('claude');
    const identity = claude.sessionId;
    appendMail(claude.id, { id: 'claude-new-mail', at: new Date().toISOString(), from: f.address, kind: 'message', text: 'Advice only.' });
    await new Promise(r => setTimeout(r, 350));
    assert.equal(f.wires(claude).filter(w => w.type === 'user').length, 1);
    f.emit(claude, { fixture: 'result' });
    await until(() => f.wires(claude).filter(w => w.type === 'user').length === 2);
    assert.match(f.wires(claude).filter(w => w.type === 'user')[1].message.content, /Unread agent mail/);
    takeUnread(claude.id);
    await f.action(claude, 'interrupt');
    appendMail(claude.id, { id: 'interrupted-mail', at: new Date().toISOString(), from: f.address, kind: 'message', text: 'Still advice.' });
    await new Promise(r => setTimeout(r, 350));
    assert.equal(f.wires(claude).filter(w => w.type === 'user').length, 2);
    const config = JSON.parse(readFileSync(process.env.CREW_CONFIG!, 'utf8'));
    writeJson(process.env.CREW_CONFIG!, { ...config, args: { ...config.args, claude: ['--permission-mode', 'bypassPermissions'] } });
    await assert.rejects(f.action(claude, 'resume', 'changed-policy'), /configuration changed/);
    assert.equal(readRun(claude.id)!.sessionId, identity);
    assert.equal(f.wires(claude).filter(w => w.type === 'user').length, 2);
    writeJson(process.env.CREW_CONFIG!, config);
    await f.action(claude, 'resume', 'restored-policy');
    await until(() => f.wires(claude).filter(w => w.type === 'user').length === 3);
    assert.equal(readRun(claude.id)!.sessionId, identity);
    const args = JSON.parse(readFileSync(join(f.root, 'providers', claude.id, 'launched.json'), 'utf8')).args;
    assert.deepEqual(args.slice(0, 2), ['--permission-mode', 'default']);
    assert.ok(args.includes(`--resume=${identity}`));
  } finally { await f.cleanup(); }
});

test('managed children retain their inherited session router override through resume', async () => {
  const f = await fixture();
  try {
    setSessionRouter(f.address, true); // Opposite of this fixture's global default.
    const codex = await f.child('codex'); const claude = await f.child('claude');
    assert.equal(f.wires(codex)[0].env.CREW_ROUTER, 'on');
    const claudeLaunch=()=>JSON.parse(readFileSync(join(f.root,'providers',claude.id,'launched.json'),'utf8'));
    assert.equal(claudeLaunch().crewRouter,'on');
    setSessionRouter(f.address, false); // Existing children keep their original choice.
    await f.action(codex,'interrupt');await f.action(codex,'resume');
    assert.equal(f.wires(codex).filter(w=>w.kind==='launch').at(-1).env.CREW_ROUTER,'on');
    await f.action(claude,'interrupt');await f.action(claude,'resume');
    assert.equal(claudeLaunch().crewRouter,'on');
  } finally { await f.cleanup(); }
});

test('routed OpenCode retains its native transport and read-only team capability; root retirement covers its ancestry', async () => {
  const f = await fixture();
  try {
    const run = await spawn({ role: 'builder', task: 'Synthetic OpenCode packet.', cwd: f.root, keep: true, model: 'opencode/fixture', effort: 'high' });
    const launch = await until(() => { try { return JSON.parse(readFileSync(join(f.root, 'opencode-launch.json'), 'utf8')); } catch { return false; } });
    assert.equal(run.route.host, 'opencode'); assert.equal(run.route.model, 'fixture'); assert.equal(run.launcher, 'exec');
    assert.equal(run.console, undefined); assert.equal(launch.run, run.id); assert.equal(launch.home, f.root);
    assert.equal(launch.args[0], 'run'); assert.ok(launch.args.includes('fixture'));
    const detail = f.controller.childDetail(f.id, run.id)!;
    assert.equal(detail.child.managed, false); assert.equal(detail.child.capabilities.approvals, false);
    assert.equal(detail.child.capabilities.interrupt, false); assert.equal(detail.requests.length, 0);
    await assert.rejects(f.controller.childAction(f.id, run.id, { requestId: 'unsupported-controls', action: 'interrupt', revision: 0 }), /no console-owned native pipe/);
    assert.equal(managedConsoleParent({ mailbox: run.id, host: 'opencode' }), undefined);
    // The root retirement fence protects native subtrees even before their own stop snapshot.
    writeJson(join(mailDir(f.address.mailbox), 'console-retired.json'), { consoleSessionId: f.id });
    process.env.CREW_RUN = run.id;
    await assert.rejects(spawn({ role: 'builder', task: 'Forbidden late descendant.', cwd: f.root, keep: true, model: 'codex/fixture', effort: 'high' }), /retired parent/);
    delete process.env.CREW_RUN;
    await f.controller.action(f.id, { requestId: 'close-opencode-team', action: 'close', revision: f.controller.detail(f.id)!.session.revision });
    await until(() => !processExists(launch.pid));
    assert.equal(readRun(run.id)!.state, 'stopped'); assert.equal(f.controller.childDetail(f.id, run.id)!.child.managed, false);
  } finally { await f.cleanup(); }
});
