import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ConsoleController } from '../../src/console-controller.ts';
import { validateMcpServers } from '../../src/mcp-config.ts';
import type { ConsoleChild, ConsoleChildDetail, ConsoleChildMutation, ConsoleCommand, ConsoleDetail, ConsoleEvent, ConsoleMutation, ConsoleProvider, ConsoleRequest, ConsoleSession, ConsoleTeam } from '../../src/console-types.ts';
import { AcpError, AcpStore } from './store.ts';
import type { AcpSession, SavedEvent } from './store.ts';
import { AcpWire, object, optionalObject, promptText, readMessages, safeId, text } from './wire.ts';
import type { JsonObject, RpcId } from './wire.ts';

interface Feed {
  cursor: string;
  changes: ({ cursor: string } & ({ kind: 'event'; event: ConsoleEvent } | { kind: 'session'; session: ConsoleSession } | { kind: 'requests'; requests: ConsoleRequest[] } | { kind: 'command'; command: ConsoleCommand }))[];
  more: boolean;
  gap?: { reason: string };
}
/** The optional facade consumes the public controller, never native provider RPC or app IDs. */
export interface AcpController {
  root: string;
  bootstrap(): { providers: ConsoleProvider[] };
  detail(id: string, before?: string): ConsoleDetail | undefined;
  session(id: string): ConsoleSession | undefined;
  requests(id: string): ConsoleRequest[];
  childRequests(id: string, run: string): ConsoleRequest[];
  refreshMcp(id: string, servers: unknown): void;
  team(id: string): ConsoleTeam | undefined;
  childDetail(id: string, run: string, before?: string): ConsoleChildDetail | undefined;
  events(id: string, cursor?: string, limit?: number): Feed;
  childEvents(id: string, run: string, cursor?: string, limit?: number): Feed;
  launch(value: unknown): Promise<ConsoleMutation>;
  message(id: string, value: unknown): Promise<ConsoleMutation>;
  configure(id: string, value: unknown): Promise<ConsoleMutation>;
  action(id: string, value: unknown): Promise<ConsoleMutation>;
  answer(id: string, value: unknown): Promise<ConsoleMutation>;
  childAction(id: string, run: string, value: unknown): Promise<ConsoleChildMutation>;
  childAnswer(id: string, run: string, value: unknown): Promise<ConsoleChildMutation>;
  suspend(id: string): Promise<void>;
}
interface ActivePrompt { requestId: string; cancelled: boolean }
interface LiveSession {
  saved: AcpSession;
  history: Map<string, SavedEvent>;
  cursors: Map<string, string>;
  workers: Map<string, string>;
  requests: Set<string>;
  pending: Map<string, ConsoleRequest[]>;
  commands: Map<string, ConsoleCommand>;
  active?: ActivePrompt;
  delivery?: Promise<ConsoleMutation>;
  configuration?: Promise<unknown>;
  changed: Set<() => void>;
}
const freshRequest = (): string => `acp-${randomBytes(16).toString('hex')}`;
const terminal = new Set(['idle', 'interrupted', 'failed', 'disconnected', 'closed']);
const workerId = (id: string, run: string): string => `acpc-${createHash('sha256').update(`${id}/${run}`).digest('hex').slice(0, 32)}`;
const modes = [{ id: 'advisor', name: 'Advisor', description: 'Lead one workstream with Crew makers.' }, { id: 'cos', name: 'Chief of staff', description: 'Coordinate advisor workstreams with Crew.' }];
const cwdInput = (value: unknown): string => {
  const cwd = text(value, 'cwd', 4096);
  if (!isAbsolute(cwd)) throw new AcpError('cwd must be absolute.');
  try { const path = realpathSync(cwd); if (statSync(path).isDirectory()) return path; } catch { /* unavailable path */ }
  throw new AcpError('cwd must name an accessible directory.');
};
function mcpInput(value: unknown) {
  try { return validateMcpServers(value); } catch { throw new AcpError('Invalid MCP server configuration.'); }
}

export class AcpServer {
  readonly store: AcpStore;
  private initialized = false;
  private capabilities: JsonObject = {};
  private live = new Map<string, LiveSession>();
  private activeRpcIds = new Set<RpcId>();
  private loading = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private pollPromise: Promise<void> | undefined;
  private closing = false;
  private cleanup: Promise<void> | undefined;
  private operations = new Set<Promise<unknown>>();
  private commands = new Set<Promise<unknown>>();
  readonly controller: AcpController;
  readonly wire: AcpWire;
  constructor(controller: AcpController, wire: AcpWire, pollMs = 100) {
    this.controller = controller; this.wire = wire;
    this.store = new AcpStore(controller.root);
    this.timer = setInterval(() => { void this.poll(); }, pollMs);
    this.timer.unref();
  }
  private models() {
    return this.controller.bootstrap().providers.filter(p => p.available).flatMap(provider => provider.models.map(model => ({ modelId: `${provider.id}/${model.id}`, name: `${provider.label} · ${model.label}`, host: provider.id, model: model.id, efforts: model.efforts ?? [], accessModes: provider.capabilities.accessModes ?? ['default'] })));
  }
  private model(id: string) { const model = this.models().find(m => m.modelId === id); if (!model) throw new AcpError('Choose an available model from the Crew roster.'); return model; }
  private sessionModels(saved: AcpSession) {
    const host = saved.modelId.split('/')[0];
    return this.models().filter(model => !saved.launchRequestId || model.host === host);
  }
  private config(saved: AcpSession) {
    const model = this.models().find(m => m.modelId === saved.modelId);
    return [
      { id: 'model', name: 'Lead model', category: 'model', type: 'select', currentValue: saved.modelId, options: this.sessionModels(saved).map(m => ({ value: m.modelId, name: m.name })) },
      { id: 'mode', name: 'Crew workflow', category: 'mode', type: 'select', currentValue: saved.mode, options: modes.map(m => ({ value: m.id, name: m.name, description: m.description })) },
      ...(model?.efforts.length ? [{ id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: saved.effort ?? model.efforts[0], options: model.efforts.map(value => ({ value, name: value })) }] : []),
      { id: 'access', name: 'Native permissions', category: '_crew_access', type: 'select', currentValue: saved.access, options: (model?.accessModes ?? ['default']).map(value => ({ value, name: value === 'default' ? 'Host default' : value === 'full' ? 'Full access' : 'Workspace' })) },
    ];
  }
  private setup(saved: AcpSession) {
    return { modes: { currentModeId: saved.mode, availableModes: modes }, models: { currentModelId: saved.modelId, availableModels: this.sessionModels(saved).map(({ modelId, name }) => ({ modelId, name })) }, configOptions: this.config(saved) };
  }
  private requireSession(value: unknown): LiveSession {
    const id = text(value, 'sessionId', 128);
    if (this.loading.has(id)) throw new AcpError('Session load is in progress.', -32004);
    const live = this.live.get(id);
    if (!live) throw new AcpError('Load or create this session first.', -32002);
    this.store.assertOwned(id);
    return live;
  }
  private install(saved: AcpSession): LiveSession {
    const cursors = new Map<string, string>();
    const history = this.store.history(saved.id, (target, cursor) => cursors.set(target, cursor));
    const live: LiveSession = { saved, history, cursors, workers: new Map(), requests: new Set(), pending: new Map(), commands: new Map(), changed: new Set() };
    this.live.set(saved.id, live); return live;
  }
  private update(live: LiveSession, update: JsonObject): void { this.wire.notify('session/update', { sessionId: live.saved.id, update }); }
  private metadata(live: LiveSession, child?: ConsoleChild): JsonObject {
    if (!child) return { version: 1 };
    return { version: 1, runId: child.runId, ...(child.parentRunId ? { parentRunId: child.parentRunId } : {}), childSessionId: workerId(live.saved.id, child.runId), role: child.role, title: child.title, task: child.title, model: `${child.host}/${child.model}`, effort: child.effort, state: child.runState, nativeState: child.state, ...(child.assignmentState ? { assignmentState: child.assignmentState } : {}), managed: child.managed };
  }
  private event(live: LiveSession, item: SavedEvent, replay = false): void {
    const key = `${item.target}/${item.event.id}`;
    const previous = replay ? undefined : live.history.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) return;
    if (!replay) { this.store.append(live.saved.id, item); live.history.set(key, item); }
    const event = item.event;
    const meta = { crew: { ...item.crew, eventId: event.id } };
    if (event.kind === 'assistant' || (event.kind === 'user' && replay)) {
      const priorText = previous && 'text' in previous.event ? previous.event.text : '';
      const delta = event.text.startsWith(priorText) ? event.text.slice(priorText.length) : event.text;
      if (delta) this.update(live, { sessionUpdate: event.kind === 'user' ? 'user_message_chunk' : 'agent_message_chunk', messageId: `${item.target}:${event.id}`, content: { type: 'text', text: delta }, _meta: meta });
    } else if (event.kind === 'tool') {
      this.update(live, { sessionUpdate: previous ? 'tool_call_update' : 'tool_call', toolCallId: `${item.target}:${event.id}`, title: event.title, kind: 'other', status: event.state === 'running' ? 'in_progress' : event.state, content: [{ type: 'content', content: { type: 'text', text: event.text } }], _meta: meta });
    } else if (event.kind === 'status' && !previous) {
      this.update(live, { sessionUpdate: 'agent_message_chunk', messageId: `${item.target}:${event.id}`, content: { type: 'text', text: `${event.text}\n` }, _meta: meta });
    }
  }
  private async feed(live: LiveSession, child?: ConsoleChild): Promise<void> {
    const id = live.saved.consoleId!;
    const target = child?.runId ?? 'root';
    const crew = this.metadata(live, child);
    for (let page = 0; page < 20; page++) {
      const cursor = live.cursors.get(target);
      const feed = child ? this.controller.childEvents(id, child.runId, cursor, 250) : this.controller.events(id, cursor, 250);
      for (const change of feed.changes) {
        if (change.kind === 'event') this.event(live, { target, cursor: change.cursor, event: change.event, crew });
        else if (change.kind === 'requests') live.pending.set(target, change.requests);
        else if (change.kind === 'command' && !child) live.commands.set(change.command.requestId, change.command);
      }
      live.cursors.set(target, feed.cursor);
      if (feed.gap) this.update(live, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Some earlier native events are unavailable in the retained Crew history.\n' }, _meta: { crew } });
      if (!feed.more) break;
    }
    const pending = child ? this.controller.childRequests(id, child.runId) : this.controller.requests(id);
    for (const request of pending) {
      const key = `${target}/${request.id}`;
      if (live.requests.has(key)) continue;
      live.requests.add(key);
      this.track(this.ask(live, request, child).catch(() => {
        if (!this.closing) this.update(live, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `The ${request.kind} request could not be completed. It remains pending; use the Crew console or cancel the turn.\n` }, _meta: { crew } });
      }));
    }
  }
  private async ask(live: LiveSession, request: ConsoleRequest, child?: ConsoleChild): Promise<void> {
    const crew = this.metadata(live, child);
    let answer: JsonObject;
    if (request.kind === 'approval') {
      const response = object(await this.wire.request('session/request_permission', {
        sessionId: live.saved.id,
        toolCall: { toolCallId: `${child?.runId ?? 'root'}:${request.id}`, title: request.title, status: 'pending', content: [{ type: 'content', content: { type: 'text', text: request.description } }], _meta: { crew } },
        options: request.options.map(option => ({ optionId: option.id, name: option.label, kind: /deny|decline|reject|cancel/i.test(option.id) ? 'reject_once' : /session|always|policy/i.test(option.id) ? 'allow_always' : 'allow_once' })),
      }));
      const outcome = object(response.outcome);
      if (outcome.outcome === 'cancelled') { await this.cancel(live, child); return; }
      if (outcome.outcome !== 'selected' || !request.options.some(o => o.id === outcome.optionId)) throw new AcpError('Invalid approval choice.');
      answer = { option: outcome.optionId };
    } else {
      const elicitation = optionalObject(this.capabilities.elicitation);
      if (elicitation.form !== undefined && elicitation.form !== null) {
        const properties = Object.fromEntries(request.questions.map(q => [q.id, { type: q.multiSelect ? 'array' : 'string', description: q.question, ...(q.multiSelect ? { items: { type: 'string', ...(q.options ? { enum: q.options.map(o => o.label) } : {}) } } : q.options ? { enum: q.options.map(o => o.label) } : {}) }]));
        const response = object(await this.wire.request('elicitation/create', { sessionId: live.saved.id, mode: 'form', message: request.title, requestedSchema: { type: 'object', properties, required: request.questions.map(q => q.id) }, _meta: { crew } }));
        if (response.action !== 'accept') { await this.cancel(live, child); return; }
        answer = { answers: object(response.content) };
      } else if (optionalObject(optionalObject(this.capabilities._meta).crew).questions === true) {
        const response = object(await this.wire.request('_crew/request_question', { sessionId: live.saved.id, request, _meta: { crew } }));
        if (response.cancelled === true) { await this.cancel(live, child); return; }
        answer = { answers: object(response.answers) };
      } else throw new AcpError('Client has no supported question transport.');
    }
    if (this.closing) return;
    const current = child ? this.controller.childRequests(live.saved.consoleId!, child.runId) : this.controller.requests(live.saved.consoleId!);
    if (!current.some(pending => pending.id === request.id)) return; // Canceled/stale replies never cross turns.
    const input = { requestId: freshRequest(), pendingRequestId: request.id, ...answer };
    if (child) await this.controller.childAnswer(live.saved.consoleId!, child.runId, input);
    else await this.controller.answer(live.saved.consoleId!, input);
  }
  private poll(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    if (this.closing) return Promise.resolve();
    const operation = this.scan();
    this.pollPromise = operation;
    void operation.finally(() => { if (this.pollPromise === operation) this.pollPromise = undefined; }).catch(() => {});
    return operation;
  }
  private async scan(): Promise<void> {
    try {
      for (const live of this.live.values()) {
        if (!live.saved.consoleId || live.saved.closed) continue;
        try {
          await this.feed(live);
          for (const child of this.controller.team(live.saved.consoleId)?.children ?? []) {
            const crew = this.metadata(live, child);
            const signature = JSON.stringify([crew, child.title]);
            const previous = live.workers.get(child.runId);
            if (previous !== signature) {
              this.update(live, { sessionUpdate: previous ? 'tool_call_update' : 'tool_call', toolCallId: `crew-worker:${child.runId}`, title: child.title, kind: 'other', status: ['done', 'idle'].includes(child.runState) ? 'completed' : ['failed', 'blocked', 'stopped'].includes(child.runState) ? 'failed' : 'in_progress', _meta: { crew } });
              live.workers.set(child.runId, signature);
            }
            if (child.managed) await this.feed(live, child);
          }
        } finally { for (const wake of live.changed) wake(); live.changed.clear(); }
      }
    } catch { /* A concurrent close/missing snapshot is retried on the next bounded poll. */ }
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }
  async receive(value: unknown): Promise<void> {
    let message: JsonObject;
    try { message = object(value); } catch { this.wire.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC frame.' } }); return; }
    if (message.jsonrpc !== '2.0') { this.wire.send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Expected JSON-RPC 2.0.' } }); return; }
    if (typeof message.method !== 'string') { this.wire.response(message); return; }
    const id = message.id;
    if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') { this.wire.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request ID.' } }); return; }
    if (id !== undefined && this.activeRpcIds.has(id)) { this.wire.send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Request ID is already active.' } }); return; }
    if (id !== undefined) this.activeRpcIds.add(id);
    try {
      const operation = this.dispatch(message.method, optionalObject(message.params));
      if (message.method !== 'session/prompt') this.commands.add(operation);
      let result: unknown;
      try { result = await operation; } finally { this.commands.delete(operation); }
      if (id !== undefined) this.wire.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (id !== undefined) this.wire.send({ jsonrpc: '2.0', id, error: { code: error instanceof AcpError ? error.code : -32000, message: error instanceof Error ? error.message : 'Crew operation failed.' } });
    } finally { if (id !== undefined) this.activeRpcIds.delete(id); }
  }
  private async dispatch(method: string, params: JsonObject): Promise<unknown> {
    if (this.closing) throw new AcpError('ACP connection is closing.', -32000);
    if (method === 'initialize') {
      if (this.initialized) throw new AcpError('Connection already initialized.');
      if (!Number.isSafeInteger(params.protocolVersion) || Number(params.protocolVersion) < 1) throw new AcpError('Invalid protocol version.');
      this.capabilities = optionalObject(params.clientCapabilities); this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'crew', title: 'Crew', version: '0.16.1' }, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: false }, _meta: { crew: { version: 1, questions: true } } }, authMethods: [] };
    }
    if (!this.initialized) throw new AcpError('Initialize the ACP connection first.', -32002);
    if (method === 'session/list') {
      const cwd = params.cwd === undefined ? undefined : cwdInput(params.cwd);
      const start = params.cursor === undefined ? 0 : Number(text(params.cursor, 'cursor', 16));
      if (!Number.isSafeInteger(start) || start < 0) throw new AcpError('Invalid list cursor.');
      const sessions = this.store.list().filter(s => !cwd || s.cwd === cwd);
      return { sessions: sessions.slice(start, start + 100).map(s => ({ sessionId: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })), ...(sessions.length > start + 100 ? { nextCursor: String(start + 100) } : {}) };
    }
    if (method === 'session/new') {
      if (this.live.size >= 32) throw new AcpError('Connection session limit reached.');
      const model = this.models()[0]; if (!model) throw new AcpError('Configure an available Codex or Claude model in the Crew roster.');
      const saved = this.store.create({ cwd: cwdInput(params.cwd), modelId: model.modelId, mode: 'advisor', access: 'default', ...(model.efforts[0] ? { effort: model.efforts[0] } : {}), mcpServers: mcpInput(params.mcpServers ?? []), title: 'Crew advisor' });
      this.install(saved); return { sessionId: saved.id, ...this.setup(saved) };
    }
    if (method === 'session/load') {
      const saved = this.store.read(text(params.sessionId, 'sessionId', 128));
      if (this.loading.has(saved.id)) throw new AcpError('Session load is already in progress.', -32004);
      if (saved.cwd !== cwdInput(params.cwd)) throw new AcpError('Session cwd cannot change.');
      const servers = mcpInput(params.mcpServers ?? []);
      const existing = this.live.get(saved.id);
      if (existing?.active || existing?.configuration) throw new AcpError('Cannot load while a prompt or configuration change is active.');
      if (!existing && this.live.size >= 32) throw new AcpError('Connection session limit reached.');
      this.store.claim(saved.id);
      const live = existing ?? this.install(saved);
      this.loading.add(saved.id);
      try {
        // A disconnect may follow native acceptance before the ACP response/save.
        // The controller's committed selection is authoritative on reconnect.
        const native = live.saved.consoleId ? this.controller.session(live.saved.consoleId) : undefined;
        if (native?.model) {
          live.saved.modelId = `${native.host}/${native.model}`; live.saved.mode = native.mode;
          if (native.effort) live.saved.effort = native.effort; else delete live.saved.effort;
          this.store.save(live.saved);
        }
        if (JSON.stringify(servers) !== JSON.stringify(live.saved.mcpServers)) {
          if (live.saved.consoleId) {
            await this.controller.suspend(live.saved.consoleId);
            this.controller.refreshMcp(live.saved.consoleId, servers);
          }
          live.saved.mcpServers = servers;
          this.store.save(live.saved);
        }
        for (const item of live.history.values()) this.event(live, item, true);
        await this.poll(); return this.setup(live.saved);
      } finally { this.loading.delete(saved.id); }
    }
    const live = this.requireSession(params.sessionId);
    if (method === 'session/set_mode' || method === 'session/set_model' || method === 'session/set_config_option') {
      // Serialize selections, but leave approvals/cancel independent while a change
      // waits for the native root's next turn boundary.
      const operation = (live.configuration ?? Promise.resolve()).catch(() => {}).then(() => this.configure(live, method, params));
      live.configuration = operation;
      try { return await operation; } finally { if (live.configuration === operation) delete live.configuration; }
    }
    if (method === 'session/prompt') return this.track(this.prompt(live, promptText(params.prompt)));
    if (method === 'session/cancel') { await this.cancel(live); return {}; }
    throw new AcpError(`Unsupported method: ${method}`, -32601);
  }
  private async configure(live: LiveSession, method: string, params: JsonObject): Promise<unknown> {
    if (this.closing) throw new AcpError('ACP connection is closing.', -32004);
    await live.delivery;
    if (this.closing) throw new AcpError('ACP connection is closing.', -32004);
    const key = method === 'session/set_mode' ? 'mode' : method === 'session/set_model' ? 'model' : text(params.configId, 'configId', 64);
    const requested = text(method === 'session/set_mode' ? params.modeId : method === 'session/set_model' ? params.modelId : params.value, 'setting', 256);
    const value = key === 'model' && requested === 'default' ? live.saved.modelId : requested;
    const current = key === 'model' ? live.saved.modelId : key === 'mode' ? live.saved.mode : key === 'effort' ? live.saved.effort : key === 'access' ? live.saved.access : undefined;
    if (value === current) return method === 'session/set_config_option' ? { configOptions: this.config(live.saved) } : {};
    const selected = { ...live.saved };
    if (key === 'model') {
      const model = this.model(value);
      if (selected.launchRequestId && model.host !== selected.modelId.split('/')[0]) throw new AcpError('This chat keeps its native provider. Choose another model from the same provider, or start a new chat to switch between Codex and Claude.', -32004);
      selected.modelId = value;
      if (!selected.effort || !model.efforts.includes(selected.effort)) { delete selected.effort; if (model.efforts[0]) selected.effort = model.efforts[0]; }
      if (!model.accessModes.includes(selected.access)) selected.access = 'default';
    } else if (key === 'mode') {
      if (value !== 'advisor' && value !== 'cos') throw new AcpError('Unknown Crew workflow.');
      selected.mode = value; selected.title = `Crew ${value}`;
    } else if (key === 'effort') {
      if (!this.model(selected.modelId).efforts.includes(value)) throw new AcpError('Unsupported reasoning effort.');
      selected.effort = value;
    } else if (key === 'access') {
      if (selected.launchRequestId) throw new AcpError('Native permission policy is fixed after launch. Start a new session to change it.', -32004);
      if (!this.model(selected.modelId).accessModes.includes(value as AcpSession['access'])) throw new AcpError('Unsupported native permission mode.');
      selected.access = value as AcpSession['access'];
    } else throw new AcpError('Unknown session configuration option.');
    if (selected.consoleId) {
      const session = this.controller.session(selected.consoleId);
      if (!session) throw new AcpError('Recorded native session is unavailable.', -32004);
      const model = this.model(selected.modelId);
      const mutation = await this.controller.configure(selected.consoleId, { requestId: freshRequest(), revision: session.revision, host: model.host, model: model.model, mode: selected.mode, ...(selected.effort ? { effort: selected.effort } : {}) });
      for (;;) {
        if (this.closing) throw new AcpError('Configuration was interrupted by disconnect. Load the session to read its current settings.', -32004);
        await this.poll();
        const receipt = live.commands.get(mutation.command.requestId) ?? mutation.command;
        if (receipt.state === 'delivered') break;
        if (receipt.state !== 'queued') throw new AcpError(receipt.error ?? 'Native configuration change was not confirmed.', -32004);
        const native = this.controller.session(selected.consoleId);
        if (!native || ['closed', 'failed', 'disconnected'].includes(native.state)) throw new AcpError('Native session disconnected before the configuration change was confirmed. Retry after resuming the session.', -32004);
        if (this.closing) throw new AcpError('Configuration was interrupted by disconnect.', -32004);
        await new Promise<void>(resolve => live.changed.add(resolve));
      }
    }
    live.saved = selected; this.store.save(selected);
    this.update(live, { sessionUpdate: 'config_option_update', configOptions: this.config(selected) });
    if (key === 'mode') this.update(live, { sessionUpdate: 'current_mode_update', currentModeId: selected.mode });
    return method === 'session/set_config_option' ? { configOptions: this.config(selected) } : {};
  }
  private async prompt(live: LiveSession, prompt: string): Promise<unknown> {
    if (live.active) throw new AcpError('A prompt is already active; cancel it before sending another.', -32004);
    if (live.saved.closed) throw new AcpError('Session was deliberately stopped. Start a new session.', -32004);
    const active: ActivePrompt = { requestId: freshRequest(), cancelled: false };
    live.active = active;
    try {
      await live.configuration;
      if (this.closing || active.cancelled) return { stopReason: 'cancelled' };
      let mutation: ConsoleMutation;
      if (!live.saved.consoleId) {
        if (live.saved.launchRequestId) throw new AcpError('Previous launch outcome is uncertain; do not replay it.', -32004);
        const model = this.model(live.saved.modelId);
        live.saved.launchRequestId = active.requestId;
        // Record the deterministic target before sending: a crash never launches a duplicate root.
        live.saved.consoleId = `s-${createHash('sha256').update(active.requestId).digest('hex').slice(0, 24)}`;
        this.store.save(live.saved);
        live.delivery = this.controller.launch({ requestId: active.requestId, cwd: live.saved.cwd, host: model.host, model: model.model, mode: live.saved.mode, access: live.saved.access, ...(live.saved.effort ? { effort: live.saved.effort } : {}), mcpServers: live.saved.mcpServers, prompt });
        mutation = await live.delivery;
        this.update(live, { sessionUpdate: 'config_option_update', configOptions: this.config(live.saved) });
      } else {
        const session = this.controller.session(live.saved.consoleId);
        if (!session) throw new AcpError('Recorded native launch is unavailable; start a new session.', -32004);
        if (['disconnected', 'failed'].includes(session.state)) {
          live.delivery = this.controller.action(live.saved.consoleId, { requestId: freshRequest(), action: 'resume', revision: session.revision });
          const resumed = await live.delivery;
          if (resumed.command.state !== 'delivered') throw new AcpError('Native resume is not confirmed; retry after checking status.', -32004);
        }
        if (this.closing || active.cancelled) { await this.cancel(live); return { stopReason: 'cancelled' }; }
        live.delivery = this.controller.message(live.saved.consoleId, { requestId: active.requestId, text: prompt });
        mutation = await live.delivery;
      }
      if (mutation.command.state === 'failed' || mutation.command.state === 'uncertain') throw new AcpError(mutation.command.error ?? 'Native prompt delivery is unconfirmed.', -32004);
      if (active.cancelled && !this.closing) await this.cancel(live);
      for (;;) {
        await this.poll();
        const session = this.controller.session(live.saved.consoleId!);
        if (!session) throw new AcpError('Native session disappeared.', -32004);
        const receipt = live.commands.get(active.requestId) ?? mutation.command;
        if (receipt.state === 'failed' || receipt.state === 'uncertain') throw new AcpError(receipt.error ?? 'Prompt delivery failed.', -32004);
        const childrenQuiet = (this.controller.team(live.saved.consoleId!)?.children ?? []).every(child => !child.managed || terminal.has(child.state));
        if (childrenQuiet && ((receipt.state === 'delivered' && terminal.has(session.state)) || (active.cancelled && ['interrupted', 'closed', 'disconnected'].includes(session.state)))) {
          if (session.state === 'failed' || (!active.cancelled && session.state === 'disconnected')) throw new AcpError(session.error ?? 'Native session failed.', -32004);
          await this.feed(live);
          return { stopReason: active.cancelled || session.state === 'interrupted' ? 'cancelled' : 'end_turn' };
        }
        if (this.closing) return { stopReason: 'cancelled' };
        await new Promise<void>(resolve => live.changed.add(resolve));
      }
    } finally { delete live.active; delete live.delivery; this.store.save(live.saved); }
  }
  private async cancel(live: LiveSession, child?: ConsoleChild): Promise<void> {
    if (!child && live.active) live.active.cancelled = true;
    if (!live.saved.consoleId) return;
    const failures: unknown[] = [];
    const interrupt = async (target?: ConsoleChild): Promise<void> => {
      const session = target ? this.controller.childDetail(live.saved.consoleId!, target.runId)?.child : this.controller.session(live.saved.consoleId!);
      if (!session || ['closed', 'disconnected', 'failed', 'interrupted'].includes(session.state)) return;
      const input = { requestId: freshRequest(), action: 'interrupt', revision: session.revision };
      if (target) await this.controller.childAction(live.saved.consoleId!, target.runId, input);
      else await this.controller.action(live.saved.consoleId!, input);
    };
    try { await interrupt(child); } catch (error) { failures.push(error); }
    if (!child) {
      // Stop the root first so it cannot create more descendants while we cancel.
      for (const worker of this.controller.team(live.saved.consoleId)?.children ?? []) {
        if (!worker.managed || ['closed', 'disconnected', 'failed', 'interrupted'].includes(worker.state)) continue;
        try { await interrupt(worker); } catch (error) { failures.push(error); }
      }
    }
    for (const wake of live.changed) wake(); live.changed.clear();
    if (failures.length) throw new AcpError('Some native work has not confirmed cancellation. Retry cancel.', -32004);
  }
  close(): Promise<void> {
    return this.cleanup ??= this.disconnect();
  }
  private async disconnect(): Promise<void> {
    this.closing = true; clearInterval(this.timer); this.wire.close();
    for (const live of this.live.values()) { for (const wake of live.changed) wake(); live.changed.clear(); }
    await this.pollPromise;
    await Promise.allSettled([...this.commands]);
    const failures: unknown[] = [];
    const cleaned: string[] = [];
    for (const live of this.live.values()) {
      if (live.active) live.active.cancelled = true;
      try {
        await live.delivery?.catch(() => {});
        if (live.saved.consoleId && !live.saved.closed) await this.controller.suspend(live.saved.consoleId);
        for (const wake of live.changed) wake(); live.changed.clear();
        cleaned.push(live.saved.id);
      } catch (error) { failures.push(error); for (const wake of live.changed) wake(); live.changed.clear(); } // Keep the claim when cleanup could not prove termination.
    }
    await Promise.allSettled([...this.operations]);
    for (const id of cleaned) this.store.release(id);
    if (failures.length) throw new AcpError('One or more owned native sessions could not be suspended safely.', -32000);
  }
}

export interface RunAcpOptions {
  input?: Readable;
  output?: Writable;
  controller?: AcpController;
  pollMs?: number;
}
/** Lazy CLI entry: no browser, SDK package, personal app session or global configuration changes. */
export async function runAcp(options: RunAcpOptions = {}): Promise<void> {
  const wire = new AcpWire(options.output ?? process.stdout);
  const server = new AcpServer(options.controller ?? new ConsoleController(), wire, options.pollMs);
  const running = new Set<Promise<void>>();
  const input = options.input ?? process.stdin;
  const shutdown = (): void => { input.destroy(); void server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try {
    for await (const message of readMessages(input)) {
      const operation = server.receive(message);
      running.add(operation); void operation.finally(() => running.delete(operation)).catch(() => {});
    }
  } finally {
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    await server.close();
    await Promise.allSettled(running);
  }
}
