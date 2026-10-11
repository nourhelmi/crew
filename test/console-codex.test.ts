import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createCodexHost } from '../src/console-codex.ts';
import type { HostEvent, HostIdentity, HostOptions } from '../src/console-host.ts';
import type { CommandState, ConsoleRequest, ConsoleState } from '../src/console-types.ts';

type Wire = { kind: string; pid?: number; args?: string[]; env?: Record<string, string>; method?: string; id?: string | number; params: Record<string, unknown>; result?: unknown; error?: unknown };
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('fixture condition not reached');
}
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
function fixture(t: TestContext, changes: Partial<HostOptions> = {}, settings: object = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crew-console-codex-'));
  const log = join(home, 'log.jsonl'), scenarioPath = join(home, 'scenario.json'), executable = join(home, 'codex');
  writeFileSync(scenarioPath, JSON.stringify(settings));
  writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve('test/fixtures/console-codex.ts'))} "$@"\n`);
  chmodSync(executable, 0o755);
  const identities: HostIdentity[] = [], states: { state: ConsoleState; error?: string }[] = [], events: HostEvent[] = [], requests: ConsoleRequest[] = [], cancelled: string[] = [], commands: { id: string; state: CommandState; error?: string }[] = [], timeline: string[] = [];
  const host = createCodexHost({
    launch: { requestId: 'launch', cwd: home, mode: 'cos', host: 'codex', prompt: 'DO_NOT_REPLAY' },
    instructions: 'Actual crew CoS contract',
    env: { PATH: process.env.PATH, HOME: home, CREW_HOME: join(home, 'crew'), CREW_CONFIG: join(home, 'config'), CREW_ROSTER: join(home, 'roster'), CODEX_HOME: join(home, 'codex-home'), ADVISOR_STATE_DIR: join(home, 'advisor'), CREW_RUN: 'MUST_NOT_INHERIT', FAKE_CODEX_LOG: log, FAKE_CODEX_SCENARIO: scenarioPath },
    executable,
    callbacks: {
      identity(value) { identities.push(value); timeline.push(`identity:${value.sessionId}:${value.turnId || ''}`); },
      state(state, error) { states.push({ state, ...(error ? { error } : {}) }); },
      event(value) { events.push(value); },
      request(value) { requests.push(value); },
      cancelRequest(id) { cancelled.push(id); },
      command(id, state, error) { commands.push({ id, state, ...(error ? { error } : {}) }); timeline.push(`command:${id}:${state}`); },
    },
    ...changes,
  });
  const wires = (): Wire[] => {
    try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
  };
  t.after(async () => {
    await host.close();
    const pid = wires()[0]?.pid;
    if (pid) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    rmSync(home, { recursive: true, force: true });
  });
  return { host, home, wires, identities, states, events, requests, cancelled, commands, timeline, scenario: (value: object) => writeFileSync(scenarioPath, JSON.stringify(value)) };
}

test('Codex starts stdio experimental protocol, persists identity, and sends the human prompt separately', async t => {
  const f = fixture(t);
  await f.host.start();
  assert.deepEqual(f.wires().filter(w => w.method).map(w => w.method), ['initialize', 'initialized', 'thread/start']);
  assert.deepEqual(f.wires()[0]!.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(f.wires()[0]!.env?.CREW_RUN, undefined);
  const init = f.wires().find(w => w.method === 'initialize')!;
  assert.deepEqual(init.params.capabilities, { experimentalApi: true });
  const start = f.wires().find(w => w.method === 'thread/start')!;
  assert.equal(start.params.developerInstructions, 'Actual crew CoS contract');
  for (const field of ['sandbox', 'approvalPolicy', 'config', 'input']) assert.equal(field in start.params, false);
  assert.equal(JSON.stringify(f.wires()).includes('DO_NOT_REPLAY'), false);
  assert.deepEqual(f.identities, [{ sessionId: 'thread-new' }]);
  assert.equal(await f.host.send('first human prompt', 'human-1'), 'delivered');
  const send = f.wires().find(w => w.method === 'turn/start')!;
  assert.deepEqual(send.params, { threadId: 'thread-new', clientUserMessageId: 'human-1', input: [{ type: 'text', text: 'first human prompt', text_elements: [] }] });
  assert.ok(f.timeline.indexOf('identity:thread-new:') < f.timeline.indexOf('command:human-1:queued'));
  assert.deepEqual(f.identities.at(-1), { sessionId: 'thread-new', turnId: 'turn-1' });
  assert.equal(f.states.at(-1)?.state, 'running');
});

test('Codex resumes only the supplied identity, discovers the current turn, and never replays history', async t => {
  const f = fixture(t, { identity: { sessionId: 'exact-thread', turnId: 'stale-turn' } }, { activeResume: true });
  await f.host.start();
  const resume = f.wires().find(w => w.method === 'thread/resume')!;
  assert.equal(resume.params.threadId, 'exact-thread');
  assert.equal('path' in resume.params || 'history' in resume.params, false);
  assert.equal(f.wires().some(w => w.method === 'thread/start' || w.method?.startsWith('turn/')), false);
  assert.equal(JSON.stringify(f.wires()).includes('--last'), false);
  assert.deepEqual(f.identities.at(-1), { sessionId: 'exact-thread', turnId: 'turn-resumed' });
  assert.equal(await f.host.send('new input', 'new-1'), 'delivered');
  assert.equal(f.wires().find(w => w.method === 'turn/steer')!.params.expectedTurnId, 'turn-resumed');
});

test('resume fails closed for mismatched identity or active thread without a turn id', async t => {
  for (const settings of [{ wrongThread: true }, { missingActiveTurn: true }]) {
    const f = fixture(t, { identity: { sessionId: 'exact-thread' } }, settings);
    await assert.rejects(f.host.start(), /identity|turn id/);
    assert.equal(f.wires().some(w => w.method?.startsWith('turn/')), false);
  }
});

test('configured CLI defaults, explicit model/effort and workspace/full access reach app-server config', async t => {
  const f = fixture(t, {
    args: ['--sandbox', 'danger-full-access', '--ask-for-approval=on-request', '--model', 'configured-model', '-c', 'sandbox_workspace_write.network_access=true', '--enable', 'x'],
    launch: { requestId: 'launch', cwd: process.cwd(), mode: 'advisor', host: 'codex', prompt: '', access: 'workspace', model: 'picked-model', effort: 'high' },
  }, { configuredRoots: [join(tmpdir(), 'already-configured-root')] });
  await f.host.start();
  const args = f.wires()[0]!.args!;
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(args.indexOf('sandbox_mode="workspace-write"') > args.indexOf('sandbox_mode="danger-full-access"'));
  const params = f.wires().find(w => w.method === 'thread/start')!.params;
  assert.equal(params.sandbox, 'workspace-write');
  assert.equal(params.model, 'picked-model');
  const config = params.config as Record<string, unknown>;
  assert.equal(config.model_reasoning_effort, 'high');
  const roots = config['sandbox_workspace_write.writable_roots'] as string[];
  for (const path of [process.cwd(), join(f.home, 'crew'), join(f.home, 'advisor'), join(tmpdir(), 'already-configured-root'), resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()), resolve(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim())]) assert.ok(roots.includes(path), path);
  assert.equal('approvalPolicy' in params, false);
  const full = fixture(t, { launch: { requestId: 'full', cwd: f.home, mode: 'cos', host: 'codex', prompt: '', access: 'full' } });
  await full.host.start();
  assert.equal(full.wires().find(w => w.method === 'thread/start')!.params.sandbox, 'danger-full-access');
});

test('configured dangerous defaults are honored only for default access; unsupported flags fail explicitly', async t => {
  const f = fixture(t, { args: ['--dangerously-bypass-approvals-and-sandbox', '--search'] });
  await f.host.start();
  const args = f.wires()[0]!.args!;
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('web_search="live"'));
  assert.equal('sandbox' in f.wires().find(w => w.method === 'thread/start')!.params, false);
  const unsupported = fixture(t, { args: ['--profile', 'named'] });
  await assert.rejects(unsupported.host.start(), /unsupported.*app-server/);
  assert.equal(unsupported.wires().length, 0);
});

test('configured add-dir merges effective host roots while preserving default sandbox policy', async t => {
  const existing = join(tmpdir(), 'configured-root'), extra = join(tmpdir(), 'additional-root');
  const f = fixture(t, { args: ['--add-dir', extra] }, { configuredRoots: [existing] });
  await f.host.start();
  assert.deepEqual(f.wires().filter(w => w.method).map(w => w.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
  const params = f.wires().find(w => w.method === 'thread/start')!.params;
  assert.equal('sandbox' in params || 'approvalPolicy' in params, false);
  assert.deepEqual((params.config as Record<string, unknown>)['sandbox_workspace_write.writable_roots'], [existing, extra]);
});

test('assistant/tool deltas upsert by stable key and filter all reasoning and foreign/stale events', async t => {
  const f = fixture(t); await f.host.start();
  assert.equal(await f.host.send('events', 'events-1'), 'delivered');
  await until(() => f.states.at(-1)?.state === 'idle');
  const assistant = f.events.filter(e => e.kind === 'assistant');
  assert.ok(assistant.some(e => e.text === 'hel' && e.streaming));
  assert.ok(assistant.some(e => e.text === 'hello' && e.streaming));
  assert.equal(new Set(assistant.map(e => e.key)).size, 1);
  assert.equal(assistant.at(-1)?.streaming, false);
  const tool = f.events.filter((e): e is Extract<HostEvent, { kind: 'tool' }> => e.kind === 'tool' && e.title === 'npm test');
  assert.equal(tool.at(-1)?.text, 'pass\n');
  assert.equal(tool.at(-1)?.state, 'completed');
  assert.ok(f.events.some(e => e.kind === 'tool' && e.title === 'File changes' && e.state === 'failed'));
  assert.ok(f.events.some(e => e.kind === 'tool' && e.text === 'tool result'));
  assert.ok(f.events.some(e => e.kind === 'tool' && e.text === 'inspected'));
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_REASONING|FOREIGN_TEXT|STALE_TEXT/);
  assert.deepEqual(f.identities.at(-1), { sessionId: 'thread-new' });
});

test('active sends steer the exact turn and repeated client request ids never duplicate input', async t => {
  const f = fixture(t); await f.host.start();
  const first = await Promise.all([f.host.send('first', 'one'), f.host.send('second', 'two')]);
  assert.deepEqual(first, ['delivered', 'delivered']);
  assert.equal(await f.host.send('second', 'two'), 'delivered');
  const sends = f.wires().filter(w => w.method?.startsWith('turn/'));
  assert.deepEqual(sends.map(w => w.method), ['turn/start', 'turn/steer']);
  assert.equal(sends[1]!.params.expectedTurnId, 'turn-1');
  assert.equal(sends[1]!.params.clientUserMessageId, 'two');
});

test('protocol rejection fails; disconnect after send is uncertain and never auto-replayed', async t => {
  const f = fixture(t); await f.host.start();
  assert.equal(await f.host.send('reject', 'rejected'), 'failed');
  assert.equal(f.commands.at(-1)?.error, 'turn mismatch');
  assert.equal(await f.host.send('first', 'ok'), 'delivered');
  assert.equal(await f.host.send('reject', 'steer-rejected'), 'failed');
  assert.equal(f.wires().filter(w => w.method === 'turn/start').length, 2);
  assert.equal(await f.host.send('disconnect', 'ambiguous'), 'uncertain');
  assert.equal(await f.host.send('disconnect', 'ambiguous'), 'uncertain');
  assert.equal(await f.host.send('later', 'offline'), 'failed');
  assert.equal(f.wires().filter(w => w.params?.clientUserMessageId === 'ambiguous').length, 1);
  assert.equal(f.states.at(-1)?.state, 'disconnected');
});

test('a malformed acceptance reply is uncertain rather than a definitive rejection', async t => {
  const f = fixture(t); await f.host.start();
  assert.equal(await f.host.send('malformed', 'malformed'), 'uncertain');
  assert.equal(f.commands.at(-1)?.state, 'uncertain');
  assert.equal(await f.host.send('malformed', 'malformed'), 'uncertain');
  assert.equal(f.wires().filter(w => w.params?.clientUserMessageId === 'malformed').length, 1);
});

test('completion preceding RPC acknowledgement cannot revive a finished turn', async t => {
  const f = fixture(t); await f.host.start();
  assert.equal(await f.host.send('race-complete', 'race'), 'delivered');
  assert.equal(f.states.at(-1)?.state, 'idle');
  assert.deepEqual(f.identities.at(-1), { sessionId: 'thread-new' });
  assert.equal(await f.host.send('again', 'new-turn'), 'delivered');
  assert.equal(f.wires().filter(w => w.method === 'turn/start').length, 2);
});

test('approval normalization honors offered structured decisions and correlates a string request id', async t => {
  const f = fixture(t, {}, { stringRequestId: true }); await f.host.start();
  await f.host.send('approval', 'ask');
  await until(() => f.requests.length === 1);
  const request = f.requests[0]!; assert.equal(request.kind, 'approval');
  assert.equal(f.states.at(-1)?.state, 'waiting');
  assert.deepEqual(request.options.map(o => o.id), ['accept', 'decision-1', 'decline', 'cancel']);
  await assert.rejects(f.host.answer({ requestId: 'invalid', pendingRequestId: request.id, option: 'acceptForSession' }), /invalid.*decision/);
  await f.host.answer({ requestId: 'approved', pendingRequestId: request.id, option: 'decision-1' });
  assert.deepEqual(f.wires().find(w => w.id === '101' && !w.method)!.result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } } });
  assert.ok(f.cancelled.includes(request.id));
  assert.equal(f.commands.at(-1)?.state, 'delivered');
  assert.equal(f.states.at(-1)?.state, 'running');
  await assert.rejects(f.host.answer({ requestId: 'stale', pendingRequestId: request.id, option: 'accept' }), /stale/);
});

test('file-change and permission approvals answer only the requested grants', async t => {
  for (const approvalMethod of ['item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
    const f = fixture(t, {}, { approvalMethod }); await f.host.start();
    await f.host.send('approval', 'ask'); await until(() => f.requests.length === 1);
    await f.host.answer({ requestId: 'approved', pendingRequestId: f.requests[0]!.id, option: 'accept' });
    const reply = f.wires().find(w => !w.method && 'result' in w)!.result;
    assert.deepEqual(reply, approvalMethod.includes('permissions') ? { permissions: { network: { enabled: true } }, scope: 'turn' } : { decision: 'accept' });
  }
});

test('questions normalize and answer using the exact questions/answers protocol shape', async t => {
  const f = fixture(t); await f.host.start();
  await f.host.send('question', 'ask'); await until(() => f.requests.length === 1);
  const request = f.requests[0]!; assert.equal(request.kind, 'question');
  assert.deepEqual(request.questions, [{ id: 'choice', question: 'Which?', options: [{ label: 'One', description: 'first' }, { label: 'Two', description: 'second' }] }]);
  await assert.rejects(f.host.answer({ requestId: 'invalid', pendingRequestId: request.id, answers: {} }), /missing answer/);
  await f.host.answer({ requestId: 'answer', pendingRequestId: request.id, answers: { choice: ['One', 'free text'] } });
  assert.deepEqual(f.wires().find(w => !w.method && 'result' in w)!.result, { answers: { choice: { answers: ['One', 'free text'] } } });
});

test('nonblocking questions preserve running state and secret questions fail closed', async t => {
  const f = fixture(t, {}, { nonBlocking: true }); await f.host.start();
  await f.host.send('question', 'ask'); await until(() => f.requests.length === 1);
  assert.equal(f.states.at(-1)?.state, 'running');
  await f.host.answer({ requestId: 'answer', pendingRequestId: f.requests[0]!.id, answers: { choice: 'One' } });
  assert.equal(f.states.at(-1)?.state, 'running');
  f.scenario({ secret: true });
  await f.host.send('question', 'secret');
  await until(() => f.wires().some(w => !w.method && w.error !== undefined));
  assert.equal(f.requests.length, 1);
});

test('reused server IDs cannot apply old browser answers to new prompts or new connections', async t => {
  const f = fixture(t); await f.host.start();
  await f.host.send('approval', 'ask'); await until(() => f.requests.length === 1);
  const old = f.requests[0]!.id;
  await f.host.send('cancel-request', 'cancel'); await until(() => f.cancelled.length === 1);
  await f.host.send('approval', 'ask-again'); await until(() => f.requests.length === 2);
  assert.notEqual(old, f.requests[1]!.id);
  await assert.rejects(f.host.answer({ requestId: 'stale', pendingRequestId: old, option: 'accept' }), /stale/);
  assert.equal(f.wires().some(w => !w.method && 'result' in w), false);
  await f.host.answer({ requestId: 'current', pendingRequestId: f.requests[1]!.id, option: 'accept' });
  const resumed = fixture(t, { identity: { sessionId: 'thread-new' } }); await resumed.host.start();
  await resumed.host.send('approval', 'ask'); await until(() => resumed.requests.length === 1);
  assert.notEqual(old, resumed.requests[0]!.id);
  await assert.rejects(resumed.host.answer({ requestId: 'old-connection', pendingRequestId: old, option: 'accept' }), /stale/);
});

test('resolved/terminal requests are cancelled, stale and unsupported requests never become approvals', async t => {
  const f = fixture(t); await f.host.start();
  await f.host.send('approval', 'ask'); await until(() => f.requests.length === 1);
  await f.host.send('cancel-request', 'cancel'); await until(() => f.cancelled.length === 1);
  await assert.rejects(f.host.answer({ requestId: 'late', pendingRequestId: f.requests[0]!.id, option: 'accept' }), /stale/);
  await f.host.send('stale-request', 'stale-request');
  await until(() => f.wires().some(w => !w.method && w.error !== undefined));
  await f.host.send('unsupported', 'unsupported');
  await until(() => f.wires().filter(w => !w.method && w.error !== undefined).length === 2);
  assert.equal(f.requests.length, 1);
  await f.host.send('approval', 'ask-again'); await until(() => f.requests.length === 2);
  await f.host.send('finish', 'finish'); await until(() => f.cancelled.length === 2);
  await assert.rejects(f.host.answer({ requestId: 'after-turn', pendingRequestId: f.requests[1]!.id, option: 'accept' }), /stale/);
});

test('transport loss while answering is uncertain and cancels the pending request', async t => {
  const f = fixture(t, {}, { disconnectAnswers: true }); await f.host.start();
  await f.host.send('approval', 'ask'); await until(() => f.requests.length === 1);
  await assert.rejects(f.host.answer({ requestId: 'answer', pendingRequestId: f.requests[0]!.id, option: 'accept' }), /exited|closed/);
  assert.equal(f.commands.at(-1)?.state, 'uncertain');
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.states.at(-1)?.state, 'disconnected');
});

test('interrupt waits for turn completion and interrupt-and-send starts a new turn', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('active', 'active');
  await f.host.interrupt();
  assert.equal(f.states.at(-1)?.state, 'interrupted');
  assert.deepEqual(f.identities.at(-1), { sessionId: 'thread-new' });
  await f.host.send('active again', 'again');
  assert.equal(await f.host.send('replacement', 'replacement', true), 'delivered');
  const wires = f.wires();
  const interrupt = wires.filter(w => w.method === 'turn/interrupt');
  assert.deepEqual(interrupt.map(w => w.params), [{ threadId: 'thread-new', turnId: 'turn-1' }, { threadId: 'thread-new', turnId: 'turn-2' }]);
  const started = wires.findIndex(w => w.params?.clientUserMessageId === 'replacement');
  const lastCompleted = wires.findLastIndex(w => w.kind === 'interrupt-completed');
  assert.ok(started > lastCompleted);
  assert.equal(wires[started]!.method, 'turn/start');
});

test('failed or ambiguous interrupt does not transmit the replacement human input', async t => {
  for (const settings of [{ rejectInterrupt: true }, { disconnectInterrupt: true }]) {
    const f = fixture(t, {}, settings); await f.host.start(); await f.host.send('active', 'active');
    assert.equal(await f.host.send('replacement', 'replacement', true), 'failed');
    assert.equal(f.wires().some(w => w.params?.clientUserMessageId === 'replacement'), false);
  }
});

test('launch failure is bounded and close-before-start never creates a process', async t => {
  const f = fixture(t, { executable: '/nonexistent/crew-console-codex' });
  await assert.rejects(f.host.start(), /cannot launch/);
  assert.equal(await f.host.send('not sent', 'missing'), 'failed');
  const closed = fixture(t); await closed.host.close();
  await assert.rejects(closed.host.start(), /closed|disconnected/);
  assert.equal(closed.wires().length, 0);
});

test('close is idempotent, kills only the owned process, and rejects future input', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('approval', 'ask'); await until(() => f.requests.length === 1);
  await Promise.all([f.host.close(), f.host.close()]);
  assert.equal(f.states.at(-1)?.state, 'closed');
  assert.equal(f.cancelled.length, 1);
  assert.equal(await f.host.send('after close', 'after-close'), 'failed');
});
