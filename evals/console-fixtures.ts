import type { ConsoleDetail, ConsoleLaunch, ConsoleMessage, ConsoleSession } from '../src/console-types.ts';
import { tinyInstructions, tinyVerifier } from './capture.ts';
import type { ConsoleCapture } from './console-capture.ts';
import { scoreConsoleCapture } from './console-capture.ts';

/** Synthetic capture only. Does not launch a console, host or model. */
export function consoleFixture(): ConsoleCapture {
  const launch: ConsoleLaunch = { requestId: 'launch-fixture', cwd: '/synthetic/workspace', mode: 'advisor', host: 'codex', model: 'fixture', prompt: 'Repair greeting.', access: 'workspace' };
  const nonce = 'a'.repeat(48);
  const request: ConsoleMessage = { requestId: 'message-fixture', text: `Write followup.json with nonce=${nonce}.` };
  const commands = { [launch.requestId]: { requestId: launch.requestId, state: 'delivered' as const },
    [request.requestId]: { requestId: request.requestId, state: 'delivered' as const } };
  const commandReceipts = Object.fromEntries([launch, request].map(payload => [payload.requestId, {
    requestId: payload.requestId, phase: 'complete', command: commands[payload.requestId]!,
    intent: { kind: 'prompt' in payload ? 'launch' : 'message', payload },
  }]));
  const session: ConsoleSession = {
    id: 'managed-fixture', rootNodeId: 'console-managed-fixture', title: 'Eval', cwd: launch.cwd, mode: 'advisor', host: 'codex',
    model: 'fixture', access: 'workspace', state: 'idle', revision: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
    capabilities: { activeInput: 'steer', interrupt: true, approvals: true, questions: true }, pendingRequests: 0,
  };
  const first: ConsoleDetail = { session, requests: [], events: [
    { id: 'e1', sequence: 1, at: session.createdAt, kind: 'user', text: launch.prompt, command: commands[launch.requestId]! },
    { id: 'e2', sequence: 2, at: session.createdAt, kind: 'tool', title: 'Command', text: 'node verify.mjs', state: 'completed' },
    { id: 'e3', sequence: 3, at: session.updatedAt, kind: 'assistant', text: 'Repaired and verified.', streaming: false },
  ] };
  const second: ConsoleDetail = { session, requests: [], events: [...first.events,
    { id: 'e4', sequence: 4, at: session.updatedAt, kind: 'user', text: request.text, command: commands[request.requestId]! },
    { id: 'e5', sequence: 5, at: session.updatedAt, kind: 'tool', title: 'Command', text: 'Write followup.json', state: 'completed' },
    { id: 'e6', sequence: 6, at: session.updatedAt, kind: 'assistant', text: 'Fresh artifact delivered.', streaming: false },
  ] };
  const before = { 'workspace/greeting.json': '{"message":"Hello world","unchanged":"preserve-me"}',
    'workspace/verify.mjs': tinyVerifier, 'workspace/AGENTS.md': tinyInstructions };
  return {
    files: { ...before, 'workspace/followup.json': JSON.stringify({ nonce, message: 'Hello world' }) }, beforeSecond: before,
    runs: [], managedIds: [session.id], providerRequests: [{ method: 'thread/start', params: {} },
      ...[launch, request].map(body => ({ method: 'turn/start', params: { threadId: 'provider-fixture', clientUserMessageId: body.requestId,
        input: [{ type: 'text', text: 'prompt' in body ? body.prompt : body.text }] } }))],
    receipts: [{ args: ['node', 'verify.mjs'], caller: 'codex-provider-fixture', cwd: 'workspace', exitCode: 0,
      stdout: 'greeting verified\n', before, after: before }],
    launch, followup: { request, nonce, generatedAt: 200, firstCompletedAt: 100 },
    http: [launch, launch, request, request].map((body, i) => ({ method: 'POST', path: i < 2 ? '/api/console/sessions' : `/api/console/sessions/${session.id}/messages`,
      at: i < 2 ? 0 : 300, status: 200, request: body, response: { session, command: commands[body.requestId as keyof typeof commands] } })),
    identities: [
      { phase: 'first', session, providerSessionId: 'provider-fixture', commands: { [launch.requestId]: commands[launch.requestId]! }, commandReceipts: { [launch.requestId]: commandReceipts[launch.requestId]! } },
      { phase: 'second', session, providerSessionId: 'provider-fixture', commands, commandReceipts },
      { phase: 'reconnected', session, providerSessionId: 'provider-fixture', commands, commandReceipts },
    ],
    details: [{ phase: 'first', detail: first }, { phase: 'second', detail: second }, { phase: 'reconnected', detail: structuredClone(second) }],
    streams: [{ connection: 1, update: { sessions: [session], detail: structuredClone(first) } },
      { connection: 2, update: { sessions: [session], detail: structuredClone(second) } }],
  };
}

export const consoleCounterexamples: { assertion: string; name: string; mutate: (capture: ConsoleCapture) => void }[] = [
  { assertion: 'console-identity', name: 'wrong provider identity', mutate: c => { c.identities[1]!.providerSessionId = 'unrelated'; } },
  { assertion: 'console-delivery', name: 'receipt without native delivery', mutate: c => { c.details[1]!.detail.events = c.details[1]!.detail.events.filter(e => e.kind !== 'user'); } },
  { assertion: 'console-delivery', name: 'uncertain durable delivery', mutate: c => { c.identities[1]!.commands[c.followup!.request.requestId]!.state = 'uncertain'; } },
  { assertion: 'console-delivery', name: 'view delivered but durable receipt incomplete', mutate: c => { c.identities[1]!.commandReceipts[c.followup!.request.requestId]!.phase = 'attempted'; } },
  { assertion: 'console-idempotency', name: 'duplicate work', mutate: c => { c.details[1]!.detail.events.push({ ...c.details[1]!.detail.events[0]!, id: 'duplicate', sequence: 7 }); } },
  { assertion: 'console-idempotency', name: 'duplicate provider input with deduplicated UI history', mutate: c => { c.providerRequests.push(c.providerRequests[1]!); } },
  { assertion: 'console-idempotency', name: 'hidden duplicate managed launch', mutate: c => { c.managedIds.push('another-root'); } },
  { assertion: 'console-idempotency', name: 'replay launched a second session', mutate: c => { (c.http[1]!.response as { session: ConsoleSession }).session = { ...c.details[0]!.detail.session, id: 'another-managed-root' }; } },
  { assertion: 'repair-verified', name: 'missing verifier', mutate: c => { c.receipts = []; } },
  { assertion: 'repair-verified', name: 'echoed verifier', mutate: c => { c.receipts[0]!.args = ['node', '-e', 'console.log("greeting verified")', 'verify.mjs']; } },
  { assertion: 'repair-verified', name: 'verifier ran on other bytes', mutate: c => { c.receipts[0]!.before = { ...c.receipts[0]!.before, 'workspace/greeting.json': '{"message":"old"}' }; } },
  { assertion: 'console-reconnect', name: 'stale reconnect history', mutate: c => { c.streams[1]!.update.detail = structuredClone(c.details[0]!.detail); } },
  { assertion: 'second-human-input', name: 'stale nonce artifact', mutate: c => { c.beforeSecond['workspace/followup.json'] = c.files['workspace/followup.json']!; } },
  { assertion: 'nonce-artifact', name: 'nonce echoed but wrong artifact', mutate: c => { c.files['workspace/followup.json'] = '{"nonce":"old","message":"Hello world"}'; } },
  { assertion: 'bounded-diff', name: 'mutable verifier', mutate: c => { c.files['workspace/verify.mjs'] = 'console.log("greeting verified")'; } },
  { assertion: 'no-unnecessary-launch', name: 'unnecessary spawn attempt', mutate: c => { c.receipts.push({ args: ['spawn'], caller: 'codex-provider-fixture', exitCode: 1, stdout: '', before: {} }); } },
];

export function checkConsoleFixtures(): void {
  if (scoreConsoleCapture(consoleFixture(), 'fixture', 0).status !== 'pass') throw new Error('Console positive fixture failed.');
  for (const counterexample of consoleCounterexamples) {
    const capture = structuredClone(consoleFixture());
    counterexample.mutate(capture);
    const assertion = scoreConsoleCapture(capture, 'fixture', 0).cases[0]!.assertions.find(a => a.id === counterexample.assertion);
    if (assertion?.status !== 'fail') throw new Error(`Blind console scorer: ${counterexample.name}`);
  }
}
