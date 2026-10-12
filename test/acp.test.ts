import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AcpServer, runAcp } from '../adapters/acp/index.ts';
import type { AcpController } from '../adapters/acp/index.ts';
import { AcpWire, readMessages } from '../adapters/acp/wire.ts';
import { hostCapabilities } from '../src/console-controller.ts';
import type { ConsoleChild, ConsoleChildDetail, ConsoleChildMutation, ConsoleCommand, ConsoleDetail, ConsoleEvent, ConsoleFeed, ConsoleLaunch, ConsoleMutation, ConsoleRequest, ConsoleTeam } from '../src/console-types.ts';

type Obj = Record<string, any>;
const waitFor = async <T>(get: () => T | undefined | false): Promise<T> => {
  const deadline = Date.now() + 3000;
  for (;;) { const value = get(); if (value) return value; if (Date.now() > deadline) throw new Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
class FakeController implements AcpController {
  readonly root: string;
  roots = new Map<string, ConsoleDetail>();
  children = new Map<string, Map<string, ConsoleChildDetail>>();
  logs = new Map<string, ConsoleFeed['changes']>();
  launches: ConsoleLaunch[] = [];
  actions: Obj[] = [];
  answers: Obj[] = [];
  messages: Obj[] = [];
  configurations: Obj[] = [];
  suspended: string[] = [];
  refreshed: { id: string; servers: unknown }[] = [];
  finishImmediately = false;
  constructor(root: string) { this.root = root; }
  bootstrap() { return { providers: (['codex', 'claude'] as const).map(id => ({ id, label: id, available: true, models: ['', '-other'].map(suffix => ({ id: `${id}-model${suffix}`, label: `${id} model${suffix}`, efforts: ['high', 'low'] })), capabilities: hostCapabilities(id) })) }; }
  detail(id: string) { return this.roots.get(id); }
  session(id: string) { return this.roots.get(id)?.session; }
  requests(id: string) { return this.roots.get(id)?.requests ?? []; }
  childRequests(id: string, run: string) { return this.childDetail(id, run)?.requests ?? []; }
  refreshMcp(id: string, servers: unknown) { if (this.session(id)?.state !== 'disconnected') throw new Error('Must suspend first'); this.refreshed.push({ id, servers }); }
  childDetail(id: string, run: string) { return this.children.get(id)?.get(run); }
  team(id: string): ConsoleTeam | undefined { return this.roots.has(id) ? { sessionId: id, children: [...this.children.get(id)?.values() ?? []].map(d => d.child), pendingRequests: [] } : undefined; }
  events(id: string, cursor = '0', limit = 250): ConsoleFeed { const logs = this.logs.get(id) ?? []; const [root, run] = id.split('/'); const requests = run ? this.childDetail(root!, run)?.requests : this.detail(id)?.requests; const last = logs.findLast(c => c.kind === 'requests'); if (requests && JSON.stringify(last && last.kind === 'requests' ? last.requests : undefined) !== JSON.stringify(requests)) logs.push({ cursor: String(logs.length + 1), kind: 'requests', requests: structuredClone(requests) }); this.logs.set(id, logs); const index = Number(cursor); const changes = logs.slice(index, index + limit); return { cursor: String(index + changes.length), changes, more: index + changes.length < logs.length }; }
  childEvents(id: string, run: string, cursor?: string, limit?: number) { if (!this.childDetail(id, run)) throw new Error('Wrong child'); return this.events(`${id}/${run}`, cursor, limit); }
  event(id: string, event: Omit<ConsoleEvent, 'id' | 'sequence' | 'at'> & { id?: string }, run?: string): void {
    const key = run ? `${id}/${run}` : id;
    const logs = this.logs.get(key) ?? []; const sequence = logs.length + 1;
    const full = { ...event, id: event.id ?? `e${sequence}`, sequence, at: new Date().toISOString() } as ConsoleEvent;
    logs.push({ cursor: String(sequence), kind: 'event', event: full }); this.logs.set(key, logs);
    const detail = run ? this.childDetail(id, run) : this.detail(id);
    if (detail) { const old = detail.events.findIndex(e => e.id === full.id); if (old < 0) detail.events.push(full); else detail.events[old] = full; }
  }
  async launch(value: unknown): Promise<ConsoleMutation> {
    const launch = value as ConsoleLaunch; this.launches.push(launch);
    const id = `s-${createHash('sha256').update(launch.requestId).digest('hex').slice(0, 24)}`;
    const session: ConsoleDetail['session'] = { id, title: 'Fixture root', cwd: launch.cwd, mode: launch.mode, host: launch.host, ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), access: launch.access ?? 'default', state: 'running', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rootNodeId: 'fixture', capabilities: hostCapabilities(launch.host), pendingRequests: 0 };
    const command: ConsoleCommand = { requestId: launch.requestId, state: 'delivered' };
    this.roots.set(id, { session, commands: [command], events: [], requests: [] });
    this.event(id, { kind: 'user', text: launch.prompt, command } as Omit<ConsoleEvent, 'id' | 'sequence' | 'at'>);
    if (this.finishImmediately) this.finish(id, 'First answer');
    return { session, command };
  }
  finish(id: string, text = 'Done') { this.event(id, { kind: 'assistant', text, streaming: false } as Omit<ConsoleEvent, 'id' | 'sequence' | 'at'>); this.roots.get(id)!.session.state = 'idle'; }
  async message(id: string, value: unknown): Promise<ConsoleMutation> {
    const input = value as Obj; this.messages.push({ id, ...input }); const detail = this.roots.get(id)!;
    detail.session.state = 'running'; const command: ConsoleCommand = { requestId: input.requestId, state: 'delivered' }; detail.commands!.push(command);
    this.event(id, { kind: 'user', text: input.text, command } as Omit<ConsoleEvent, 'id' | 'sequence' | 'at'>);
    if (this.finishImmediately) this.finish(id, 'Follow-up answer');
    return { session: detail.session, command };
  }
  async configure(id: string, value: unknown): Promise<ConsoleMutation> {
    const input = value as Obj; this.configurations.push({ id, ...input }); const detail = this.roots.get(id)!;
    Object.assign(detail.session, { model: input.model, mode: input.mode, effort: input.effort });
    const command: ConsoleCommand = { requestId: input.requestId, state: 'delivered' };
    const logs = this.logs.get(id) ?? []; logs.push({ cursor: String(logs.length + 1), kind: 'command', command }); this.logs.set(id, logs);
    return { session: detail.session, command };
  }
  async action(id: string, value: unknown): Promise<ConsoleMutation> {
    const input = value as Obj; this.actions.push({ id, ...input }); const detail = this.roots.get(id)!;
    detail.session.state = input.action === 'resume' ? 'idle' : input.action === 'close' ? 'closed' : 'interrupted'; detail.requests = [];
    return { session: detail.session, command: { requestId: input.requestId, state: 'delivered' } };
  }
  async answer(id: string, value: unknown): Promise<ConsoleMutation> { const input = value as Obj; this.answers.push({ id, ...input }); const detail = this.roots.get(id)!; detail.requests = detail.requests.filter(r => r.id !== input.pendingRequestId); return { session: detail.session, command: { requestId: input.requestId, state: 'delivered' } }; }
  addChild(id: string, runId = 'builder-1'): ConsoleChild {
    const child: ConsoleChild = { runId, rootSessionId: id, title: 'Implement bounded task', role: 'builder', host: 'codex', model: 'codex-model', effort: 'low', cwd: this.root, keep: true, managed: true, state: 'running', runState: 'running', revision: 1, capabilities: hostCapabilities('codex'), pendingRequests: 0 };
    const children = this.children.get(id) ?? new Map(); children.set(runId, { child, events: [], requests: [] }); this.children.set(id, children); return child;
  }
  async childAction(id: string, run: string, value: unknown): Promise<ConsoleChildMutation> { const input = value as Obj; const child = this.childDetail(id, run)!.child; this.actions.push({ id, run, ...input }); child.state = 'interrupted'; return { child, command: { requestId: input.requestId, state: 'delivered' } }; }
  async childAnswer(id: string, run: string, value: unknown): Promise<ConsoleChildMutation> { const detail = this.childDetail(id, run)!; const input = value as Obj; this.answers.push({ id, run, ...input }); detail.requests = []; return { child: detail.child, command: { requestId: input.requestId, state: 'delivered' } }; }
  async suspend(id: string): Promise<void> { this.suspended.push(id); const detail = this.roots.get(id); if (detail) detail.session.state = 'disconnected'; }
}
function connection(controller: FakeController) {
  const output = new PassThrough(); const messages: Obj[] = [];
  output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) if (line) messages.push(JSON.parse(line)); });
  const server = new AcpServer(controller, new AcpWire(output), 5); let next = 0;
  const call = async (method: string, params: unknown = {}): Promise<Obj> => { const id = ++next; await server.receive({ jsonrpc: '2.0', id, method, params }); return messages.find(m => m.id === id)!; };
  const init = (clientCapabilities: Obj = {}) => call('initialize', { protocolVersion: 2, clientCapabilities });
  return { server, messages, call, init };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-acp-'));
  const prior = process.env.CREW_HOME; process.env.CREW_HOME = root;
  const controller = new FakeController(root); const clients: ReturnType<typeof connection>[] = [];
  return { root, controller, connect: () => { const c = connection(controller); clients.push(c); return c; }, cleanup: async () => { try { await Promise.all(clients.map(c => c.server.close())); } finally { if (prior === undefined) delete process.env.CREW_HOME; else process.env.CREW_HOME = prior; rmSync(root, { recursive: true, force: true }); } } };
}

test('ACP negotiates v1 truthfully, defers launch and applies roster model/workflow/effort/MCP selection', async () => {
  const f = fixture(); try {
    const c = f.connect(); assert.equal((await c.call('session/new', { cwd: f.root })).error.code, -32002);
    const init = (await c.init()).result; assert.equal(init.protocolVersion, 1); assert.equal(init.agentInfo.name, 'crew'); assert.equal(init.agentCapabilities.promptCapabilities.image, false); assert.equal(init.agentCapabilities._meta.crew.workerMail, undefined);
    const mcpServers = [{ name: 'fixture', command: '/not-executed', args: [], env: [{ name: 'PRIVATE_FIXTURE', value: 'not-a-real-secret' }] }];
    const created = (await c.call('session/new', { cwd: f.root, mcpServers })).result; const sessionId = created.sessionId;
    assert.equal(f.controller.launches.length, 0); assert.equal(statSync(c.server.store.path(sessionId)).mode & 0o777, 0o600);
    assert.equal(created.models.availableModels.length, 4);
    await c.call('session/set_model', { sessionId, modelId: 'claude/claude-model' });
    await c.call('session/set_mode', { sessionId, modeId: 'cos' });
    await c.call('session/set_config_option', { sessionId, configId: 'effort', value: 'low' });
    f.controller.finishImmediately = true;
    const result = await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Build it' }] });
    assert.equal(result.result.stopReason, 'end_turn'); assert.equal(f.controller.launches.length, 1);
    assert.equal(f.controller.launches[0]!.host, 'claude'); assert.equal(f.controller.launches[0]!.mode, 'cos'); assert.equal(f.controller.launches[0]!.effort, 'low'); assert.deepEqual(f.controller.launches[0]!.mcpServers, mcpServers);
    assert.ok((await c.call('session/set_mode', { sessionId, modeId: 'advisor' })).result);
    assert.ok(!JSON.stringify(c.messages).includes('not-a-real-secret'));
  } finally { await f.cleanup(); }
});

test('ACP streams text deltas and read-only worker tools after root completion', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const pending = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]);
    f.controller.event(id, { kind: 'assistant', id: 'stream', text: 'Hello', streaming: true } as any);
    await waitFor(() => c.messages.find(m => m.params?.update?.content?.text === 'Hello'));
    f.controller.event(id, { kind: 'assistant', id: 'stream', text: 'Hello world', streaming: false } as any);
    f.controller.roots.get(id)!.session.state = 'idle';
    assert.equal((await pending).result.stopReason, 'end_turn');
    assert.deepEqual(c.messages.filter(m => m.params?.update?.messageId?.endsWith(':stream')).map(m => m.params.update.content.text), ['Hello', ' world']);
    f.controller.addChild(id); f.controller.event(id, { kind: 'tool', title: 'Run test', text: 'passed', state: 'completed' } as any, 'builder-1');
    const tool = await waitFor(() => c.messages.find(m => m.params?.update?.title === 'Run test'));
    assert.equal(tool.params.sessionId, sessionId); assert.equal(tool.params.update._meta.crew.runId, 'builder-1'); assert.match(tool.params.update._meta.crew.childSessionId, /^acpc-/);
    assert.ok((await c.call('_crew/send_message', { sessionId, runId: 'builder-1', requestId: 'forbidden', text: 'Direct worker chat' })).error);
    assert.equal(f.controller.messages.length, 0);
  } finally { await f.cleanup(); }
});

test('ACP approvals are exact native requests, stale answers do not cross turns, and child approvals keep root transport', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    const id = [...f.controller.roots.keys()][0]!; f.controller.addChild(id);
    const detail = f.controller.childDetail(id, 'builder-1')!;
    detail.requests = [{ id: 'native-permission-1', kind: 'approval', title: 'Execute', description: 'Command', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }];
    const request = await waitFor(() => c.messages.find(m => m.method === 'session/request_permission'));
    assert.equal(request.params.sessionId, sessionId); assert.equal(request.params.toolCall._meta.crew.runId, 'builder-1');
    await c.server.receive({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await waitFor(() => f.controller.answers.length === 1);
    assert.equal(f.controller.answers[0]!.pendingRequestId, 'native-permission-1'); assert.equal(f.controller.answers[0]!.run, 'builder-1');
    detail.requests = [{ id: 'native-permission-2', kind: 'approval', title: 'Execute again', description: '', options: [{ id: 'allow', label: 'Allow' }] }];
    const next = await waitFor(() => c.messages.find(m => m.method === 'session/request_permission' && m.id !== request.id));
    detail.requests = [];
    await c.server.receive({ jsonrpc: '2.0', id: next.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.controller.answers.length, 1);
  } finally { await f.cleanup(); }
});

test('ACP questions use negotiated form elicitation, never child mail', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init({ elicitation: { form: {} } }); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    const id = [...f.controller.roots.keys()][0]!;
    f.controller.roots.get(id)!.requests = [{ id: 'question-1', kind: 'question', title: 'Choose', questions: [{ id: 'color', question: 'Color?', options: [{ label: 'blue' }] }] }];
    const request = await waitFor(() => c.messages.find(m => m.method === 'elicitation/create'));
    assert.equal(request.params.mode, 'form'); assert.deepEqual(request.params.requestedSchema.required, ['color']);
    await c.server.receive({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { color: 'blue' } } });
    await waitFor(() => f.controller.answers.length === 1); assert.deepEqual(f.controller.answers[0]!.answers, { color: 'blue' }); assert.equal(f.controller.messages.length, 0);
  } finally { await f.cleanup(); }
});

test('ACP cancel settles active prompt and rejects overlapping or multimodal prompts without a native send', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    assert.ok((await c.call('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'ignored' }] })).error); assert.equal(f.controller.launches.length, 0);
    const pending = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Keep working' }] });
    await waitFor(() => f.controller.launches.length === 1);
    assert.equal((await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Duplicate' }] })).error.code, -32004);
    await c.call('session/cancel', { sessionId }); assert.equal((await pending).result.stopReason, 'cancelled');
  } finally { await f.cleanup(); }
});

test('ACP ownership is exclusive, disconnect suspends only owned runtimes and load resumes exact native identity', async () => {
  const f = fixture(); try {
    const c = f.connect(); const other = f.connect(); await c.init(); await other.init();
    f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'First' }] });
    const id = [...f.controller.roots.keys()][0]!;
    assert.equal((await other.call('session/load', { sessionId, cwd: f.root })).error.code, -32003);
    await c.server.close(); assert.deepEqual(f.controller.suspended, [id]);
    const loaded = await other.call('session/load', { sessionId, cwd: f.root }); assert.ok(loaded.result);
    assert.ok(other.messages.some(m => m.params?.update?.content?.text === 'First answer'));
    assert.equal(f.controller.launches.length, 1);
    const result = await other.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Follow up' }] });
    assert.equal(result.result.stopReason, 'end_turn'); assert.equal(f.controller.launches.length, 1); assert.equal(f.controller.messages.at(-1)!.id, id); assert.equal(f.controller.actions.at(-1)!.action, 'resume');
  } finally { await f.cleanup(); }
});

test('ACP stdio handles EOF cleanup and bounded JSONL frames without executing anything', async () => {
  const f = fixture(); try {
    const input = new PassThrough(); const output = new PassThrough(); const replies: Obj[] = [];
    output.on('data', chunk => replies.push(...String(chunk).trim().split('\n').map(line => JSON.parse(line))));
    const running = runAcp({ input, output, controller: f.controller, pollMs: 5 });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n');
    await waitFor(() => replies.find(r => r.id === 1)); input.end(); await running;
    assert.equal(f.controller.launches.length, 0);
    const oversized = new PassThrough(); oversized.end('x'.repeat(1024 * 1024 + 1));
    await assert.rejects(async () => { for await (const ignored of readMessages(oversized)) void ignored; }, /exceeds/);
  } finally { await f.cleanup(); }
});

test('ACP accepts default model alias and repeated actual selection without changing a launched model', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    assert.ok((await c.call('session/set_model', { sessionId, modelId: 'default' })).result);
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    assert.ok((await c.call('session/set_model', { sessionId, modelId: 'default' })).result);
    assert.ok((await c.call('session/set_model', { sessionId, modelId: 'codex/codex-model' })).result);
    assert.equal((await c.call('session/set_model', { sessionId, modelId: 'claude/claude-model' })).error.code, -32004);
    assert.equal(f.controller.launches.length, 1);
  } finally { await f.cleanup(); }
});

test('ACP changes lead model, effort and workflow in the same chat without changing its workers', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'First turn' }] });
    const id = c.server.store.read(sessionId).consoleId!;
    const child = f.controller.addChild(id); child.state = 'idle';
    const before = structuredClone(child);
    const changed = await c.call('session/set_config_option', { sessionId, configId: 'model', value: 'codex/codex-model-other' });
    assert.ok(changed.result, JSON.stringify(changed.error));
    const models = changed.result.configOptions.find((option: Obj) => option.id === 'model');
    assert.equal(models.currentValue, 'codex/codex-model-other');
    assert.ok(models.options.every((option: Obj) => option.value.startsWith('codex/')));
    assert.ok((await c.call('session/set_config_option', { sessionId, configId: 'effort', value: 'low' })).result);
    assert.ok((await c.call('session/set_mode', { sessionId, modeId: 'cos' })).result);
    assert.equal((await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue' }] })).result.stopReason, 'end_turn');
    assert.equal(f.controller.session(id)!.model, 'codex-model-other');
    assert.equal(f.controller.session(id)!.mode, 'cos'); assert.equal(f.controller.session(id)!.effort, 'low');
    assert.deepEqual(child, before); assert.equal(f.controller.launches.length, 1);
    assert.equal(f.controller.messages.at(-1)!.id, id);
    assert.ok((await c.call('session/set_model', { sessionId, modelId: 'codex/codex-model' })).result);
    assert.ok((await c.call('session/set_mode', { sessionId, modeId: 'advisor' })).result);
    await c.server.close(); const next = f.connect(); await next.init();
    const loaded = (await next.call('session/load', { sessionId, cwd: f.root })).result;
    assert.equal(loaded.modes.currentModeId, 'advisor'); assert.equal(loaded.models.currentModelId, 'codex/codex-model');
    assert.equal(loaded.configOptions.find((option: Obj) => option.id === 'effort').currentValue, 'low');
    assert.equal(next.server.store.read(sessionId).consoleId, id);
  } finally { await f.cleanup(); }
});

test('ACP waits for a queued change while approvals and the current prompt continue independently', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Work' }] });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]);
    const apply = f.controller.configure.bind(f.controller); let queued: Obj | undefined;
    f.controller.configure = async (target, value) => { queued = value as Obj; return { session: f.controller.session(target)!, command: { requestId: queued.requestId, state: 'queued' } }; };
    let changed = false;
    const change = c.call('session/set_mode', { sessionId, modeId: 'cos' }).then(result => { changed = true; return result; });
    await waitFor(() => queued); assert.equal(changed, false);
    assert.equal(c.server.store.read(sessionId).mode, 'advisor');
    const detail = f.controller.detail(id)!; detail.session.state = 'waiting';
    detail.requests = [{ id: 'permission-during-change', kind: 'approval', title: 'Existing turn approval', description: '', options: [{ id: 'allow', label: 'Allow' }] }];
    const permission = await waitFor(() => c.messages.find(message => message.method === 'session/request_permission'));
    await c.server.receive({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await waitFor(() => f.controller.answers.length === 1); assert.equal(changed, false);
    f.controller.finish(id); await apply(id, queued);
    assert.ok((await change).result); assert.equal((await prompt).result.stopReason, 'end_turn');
    assert.equal(c.server.store.read(sessionId).mode, 'cos');
    assert.equal(f.controller.actions.length, 0); assert.equal(f.controller.suspended.length, 0);
  } finally { await f.cleanup(); }
});

test('ACP configures after a racing first launch and serializes subsequent selections', async () => {
  const f = fixture(); let release!: () => void; try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const launch = f.controller.launch.bind(f.controller);
    f.controller.launch = async input => { await new Promise<void>(resolve => { release = resolve; }); return launch(input); };
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'First' }] });
    await waitFor(() => release);
    const cos = c.call('session/set_mode', { sessionId, modeId: 'cos' });
    const advisor = c.call('session/set_mode', { sessionId, modeId: 'advisor' });
    assert.equal(f.controller.configurations.length, 0); release();
    assert.equal((await prompt).result.stopReason, 'end_turn');
    assert.ok((await cos).result); assert.ok((await advisor).result);
    assert.deepEqual(f.controller.configurations.map(config => config.mode), ['cos', 'advisor']);
    assert.equal(c.server.store.read(sessionId).mode, 'advisor'); assert.equal(f.controller.launches.length, 1);
  } finally { release?.(); await f.cleanup(); }
});

test('ACP leaves rejected configuration unchanged and reconciles accepted native state after reconnect', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'First' }] });
    const id = c.server.store.read(sessionId).consoleId!;
    f.controller.configure = async () => { throw new Error('Native model rejected'); };
    assert.match((await c.call('session/set_model', { sessionId, modelId: 'codex/codex-model-other' })).error.message, /Native model rejected/);
    assert.equal(c.server.store.read(sessionId).modelId, 'codex/codex-model');
    const native = f.controller.session(id)!; native.model = 'codex-model-other'; native.mode = 'cos'; native.effort = 'low';
    await c.server.close(); const next = f.connect(); await next.init();
    const loaded = (await next.call('session/load', { sessionId, cwd: f.root })).result;
    assert.equal(loaded.models.currentModelId, 'codex/codex-model-other'); assert.equal(loaded.modes.currentModeId, 'cos');
    assert.equal(next.server.store.read(sessionId).consoleId, id);
  } finally { await f.cleanup(); }
});

test('ACP disconnect releases a pending configuration without waiting for the active turn to finish', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Work' }] });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]); let queued = false;
    f.controller.configure = async (target, value) => { queued = true; return { session: f.controller.session(target)!, command: { requestId: (value as Obj).requestId, state: 'queued' } }; };
    const change = c.call('session/set_mode', { sessionId, modeId: 'cos' });
    await waitFor(() => queued); await c.server.close();
    await Promise.all([change, prompt]); assert.deepEqual(f.controller.suspended, [id]);
    assert.equal(c.server.store.read(sessionId).mode, 'advisor');
  } finally { await f.cleanup(); }
});

test('ACP releases pending configuration when its native owner disappears, so the chat can recover', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Work' }] });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]); let queued = false;
    f.controller.configure = async (target, value) => { queued = true; return { session: f.controller.session(target)!, command: { requestId: (value as Obj).requestId, state: 'queued' } }; };
    const change = c.call('session/set_mode', { sessionId, modeId: 'cos' });
    await waitFor(() => queued); f.controller.session(id)!.state = 'disconnected';
    assert.match((await change).error.message, /disconnected/); assert.ok((await prompt).error);
    assert.equal(c.server.store.read(sessionId).mode, 'advisor');
    f.controller.finishImmediately = true;
    assert.equal((await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Recover' }] })).result.stopReason, 'end_turn');
    assert.equal(f.controller.launches.length, 1); assert.equal(f.controller.actions.at(-1)!.action, 'resume');
  } finally { await f.cleanup(); }
});

test('ACP namespaced questions require negotiation and cancelled answers interrupt instead of authorizing by mail', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init({ _meta: { crew: { questions: true } } }); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    const id = [...f.controller.roots.keys()][0]!;
    f.controller.roots.get(id)!.requests = [{ id: 'question-1', kind: 'question', title: 'Choose', questions: [{ id: 'q', question: 'What next?' }] }];
    const request = await waitFor(() => c.messages.find(m => m.method === '_crew/request_question'));
    await c.server.receive({ jsonrpc: '2.0', id: request.id, result: { cancelled: true } });
    await waitFor(() => f.controller.actions.length === 1); assert.equal(f.controller.actions[0]!.action, 'interrupt');
    assert.equal(f.controller.answers.length, 0); assert.equal(f.controller.messages.length, 0);
  } finally { await f.cleanup(); }
});

test('ACP disconnect waits for a racing launch before suspending, and failed cleanup does not release ownership', async () => {
  const f = fixture(); let finishLaunch!: () => void;
  try {
    const c = f.connect(); await c.init();
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const original = f.controller.launch.bind(f.controller);
    f.controller.launch = async value => { await new Promise<void>(resolve => { finishLaunch = resolve; }); return original(value); };
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Race' }] });
    await waitFor(() => finishLaunch);
    const closing = c.server.close(); assert.equal(f.controller.suspended.length, 0);
    finishLaunch(); await closing; await prompt; assert.equal(f.controller.suspended.length, 1);
    const next = f.connect(); await next.init(); assert.ok((await next.call('session/load', { sessionId, cwd: f.root })).result);
    const suspend = f.controller.suspend.bind(f.controller);
    f.controller.suspend = async () => { throw new Error('fixture cleanup failure'); };
    await assert.rejects(next.server.close(), /could not be suspended/);
    const other = f.connect(); await other.init(); assert.equal((await other.call('session/load', { sessionId, cwd: f.root })).error.code, -32003);
    f.controller.suspend = suspend;
  } finally {
    // Failed cleanup deliberately retains ownership; this test owns the fake runtime and temp directory.
    await f.cleanup().catch(() => {});
  }
});

test('ACP keeps root prompt open for active and approval-waiting workers, then cancellation interrupts the owned tree', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    let complete = false;
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Delegate' }] }).then(result => { complete = true; return result; });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]);
    const worker = f.controller.addChild(id); worker.state = 'waiting'; f.controller.finish(id);
    await waitFor(() => c.messages.find(m => m.params?.update?._meta?.crew.runId === worker.runId));
    assert.equal(complete, false);
    await c.call('session/cancel', { sessionId }); assert.equal((await prompt).result.stopReason, 'cancelled');
    assert.ok(f.controller.actions.some(a => a.id === id && !a.run && a.action === 'interrupt'));
    assert.ok(f.controller.actions.some(a => a.id === id && a.run === worker.runId && a.action === 'interrupt'));
    assert.equal(f.controller.suspended.length, 0);
  } finally { await f.cleanup(); }
});

test('ACP replay does not resend earlier streaming snapshots after loading final text', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    const prompt = c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Stream' }] });
    const id = await waitFor(() => [...f.controller.roots.keys()][0]);
    f.controller.event(id, { kind: 'assistant', id: 'reply', text: 'First', streaming: true } as any);
    await waitFor(() => c.messages.find(m => m.params?.update?.content?.text === 'First'));
    f.controller.event(id, { kind: 'assistant', id: 'reply', text: 'First final', streaming: false } as any); f.controller.roots.get(id)!.session.state = 'idle';
    await prompt; await c.server.close();
    const next = f.connect(); await next.init(); await next.call('session/load', { sessionId, cwd: f.root });
    assert.deepEqual(next.messages.filter(m => m.params?.update?.messageId?.endsWith(':reply')).map(m => m.params.update.content.text), ['First final']);
  } finally { await f.cleanup(); }
});

test('ACP reload refreshes private MCP configuration only after suspension and keeps native identity', async () => {
  const f = fixture(); try {
    const c = f.connect(); await c.init(); f.controller.finishImmediately = true;
    const sessionId = (await c.call('session/new', { cwd: f.root })).result.sessionId;
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Task' }] });
    const id = [...f.controller.roots.keys()][0]!;
    const mcpServers = [{ name: 'client-tools', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'fixture-rotated-private' }] }];
    assert.ok((await c.call('session/load', { sessionId, cwd: f.root, mcpServers })).result);
    assert.deepEqual(f.controller.suspended, [id]); assert.deepEqual(f.controller.refreshed, [{ id, servers: mcpServers }]);
    assert.ok(!JSON.stringify(c.messages).includes('fixture-rotated-private'));
    assert.equal(f.controller.launches.length, 1); assert.equal(c.server.store.read(sessionId).consoleId, id);
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue' }] });
    assert.equal(f.controller.launches.length, 1); assert.equal(f.controller.messages.at(-1)!.id, id);
  } finally { await f.cleanup(); }
});
