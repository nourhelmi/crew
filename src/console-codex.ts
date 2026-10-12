import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { codexMcpServers } from './mcp-config.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConsoleAnswer, ConsoleRequest, ConsoleState, CommandState } from './console-types.ts';
import type { ConsoleHostAdapter, HostEvent, HostOptions } from './console-host.ts';
import { recordProcess, terminateOwnedProcess } from './console-process.ts';
import type { OwnedProcess } from './console-process.ts';

// Wire shapes verified against `codex app-server generate-ts --experimental` (0.160.1).
// Keep the small consumed subset here; generated bindings are not a runtime dependency.
type ObjectValue = Record<string, unknown>;
type RpcId = string | number;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const TIMEOUT = 30_000;
const MAX_TEXT = 24_000, MAX_HISTORY = 10_000, MAX_EVENTS = 1000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024, MAX_EARLY_BYTES = 4 * 1024 * 1024;

class Rejected extends Error {}
class TransportError extends Error {
  transmitted: boolean;
  constructor(text: string, transmitted: boolean) { super(text); this.transmitted = transmitted; }
}
interface PendingRpc { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface PendingAnswer {
  rpcId: RpcId;
  turnId: string;
  itemId: string;
  request: ConsoleRequest;
  blocking: boolean;
  bytes: number;
  results?: Map<string, unknown>;
  replying?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
}

/** TUI flags are ignored by app-server 0.160.1. Translate configuration we can honor;
 * reject other flags rather than silently changing the configured access policy. */
function configuredArgs(args: string[]): { args: string[]; roots: string[] } {
  const output: string[] = [], roots: string[] = [];
  const config = (key: string, value: unknown) => output.push('-c', `${key}=${JSON.stringify(value)}`);
  const values: Record<string, string> = { '-m': 'model', '--model': 'model', '-s': 'sandbox_mode', '--sandbox': 'sandbox_mode', '-a': 'approval_policy', '--ask-for-approval': 'approval_policy' };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const equals = raw.indexOf('=');
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    const value = () => {
      const result = equals < 0 ? args[++i] : raw.slice(equals + 1);
      if (!result) throw new Error(`crew: missing value for Codex argument ${flag}`);
      return result;
    };
    if (flag === '-c' || flag === '--config') output.push('-c', value());
    else if (flag === '--enable' || flag === '--disable') config(`features.${value()}`, flag === '--enable');
    else if (values[flag]) config(values[flag]!, value());
    else if (flag === '--add-dir') roots.push(value());
    else if (flag === '--search') config('web_search', 'live');
    else if (flag === '--dangerously-bypass-approvals-and-sandbox') { config('sandbox_mode', 'danger-full-access'); config('approval_policy', 'never'); }
    else if (flag === '--approve-for-me') { config('sandbox_mode', 'workspace-write'); config('approvals_reviewer', 'guardian'); }
    else if (flag === '--strict-config') output.push(flag);
    else throw new Error(`crew: configured Codex argument ${flag} is unsupported by the console app-server`);
  }
  return { args: output, roots };
}

function workspaceRoots(options: HostOptions, extra: string[]): string[] {
  const env = options.env, cwd = options.launch.cwd, userHome = env.HOME || homedir();
  const roots = [cwd, env.CREW_HOME || join(userHome, '.crew'), env.ADVISOR_STATE_DIR || join(userHome, '.advisor'), ...extra];
  // Both the worktree git dir and its common dir are needed for commits in a worktree.
  for (const flag of ['--git-dir', '--git-common-dir']) {
    try {
      const path = execFileSync('git', ['-C', cwd, 'rev-parse', flag], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
      if (path) roots.push(resolve(cwd, path));
    } catch { /* Non-git projects still have workspace and Crew state access. */ }
  }
  return [...new Set(roots.map(path => resolve(cwd, path)))];
}

export function createCodexHost(options: HostOptions): ConsoleHostAdapter {
  const callbacks = options.callbacks;
  let child: ChildProcessWithoutNullStreams | undefined;
  let sessionId = '', turnId: string | undefined;
  let provider: OwnedProcess | undefined;
  let dead = false, closing = false, ready = false, nextId = 0;
  let startPromise: Promise<void> | undefined, closePromise: Promise<void> | undefined, stopPromise: Promise<void> | undefined;
  let sequence = Promise.resolve();
  let state: ConsoleState = 'starting';
  const pending = new Map<number, PendingRpc>();
  const requests = new Map<string, PendingAnswer>();
  const requestKeys = new Map<RpcId, string>();
  let requestBytes = 0;
  const commands = new Map<string, Promise<CommandState>>();
  const events = new Map<string, HostEvent>();
  const terminalTurns = new Set<string>();
  const early: ObjectValue[] = [];
  let earlyBytes = 0;
  const turnWaiters = new Map<string, Set<() => void>>();
  const instance = randomUUID();
  let requestSequence = 0;
  const setState = (next: ConsoleState, error?: string) => {
    if (dead && next !== 'disconnected' && next !== 'closed') return;
    state = next; callbacks.state(next, error);
  };
  const identity = () => callbacks.identity({ sessionId, ...(turnId ? { turnId } : {}), ...(provider ? { provider } : {}) });
  const currentState = () => setState([...requests.values()].some(request => request.blocking) ? 'waiting' : turnId ? 'running' : 'idle');
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = sequence.then(action);
    sequence = result.then(() => {}, () => {});
    return result;
  };
  function cancel(id: string, error = 'crew: Codex request is no longer current'): void {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    requestKeys.delete(request.rpcId);
    requestBytes -= request.bytes;
    if (request.replying) { clearTimeout(request.replying.timer); request.replying.reject(new TransportError(error, true)); }
    callbacks.cancelRequest(id);
  }
  function disconnect(error: string): void {
    if (dead) return;
    dead = true; ready = false;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new TransportError(error, true)); }
    pending.clear();
    for (const id of requests.keys()) cancel(id, error);
    events.clear(); early.length = 0; earlyBytes = 0; terminalTurns.clear();
    for (const waiters of turnWaiters.values()) for (const wake of waiters) wake();
    turnWaiters.clear();
    if (!closing) setState('disconnected', error);
    void shutdown().catch(cleanup => setState('disconnected', `${error}; cleanup failed: ${message(cleanup)}`));
  }
  function write(value: object): Promise<void> {
    if (!child || dead || closing || !child.stdin.writable) return Promise.reject(new TransportError('crew: Codex app-server is disconnected', false));
    return new Promise<void>((resolveWrite, reject) => {
      child!.stdin.write(JSON.stringify(value) + '\n', error => {
        if (error) { disconnect('crew: Codex app-server pipe failed'); reject(new TransportError('crew: Codex app-server pipe failed', true)); }
        else resolveWrite();
      });
    });
  }
  function rpc(method: string, params: object): Promise<unknown> {
    if (!child || dead || closing) return Promise.reject(new TransportError('crew: Codex app-server is disconnected', false));
    const id = ++nextId;
    return new Promise((resolveRpc, reject) => {
      const timer = setTimeout(() => disconnect(`crew: Codex ${method} timed out; delivery is unknown`), TIMEOUT);
      pending.set(id, { resolve: resolveRpc, reject, timer });
      void write({ id, method, params }).catch(error => {
        const call = pending.get(id);
        if (call) { clearTimeout(call.timer); pending.delete(id); call.reject(error); }
      });
    });
  }
  function emit(key: string, event: HostEvent): void {
    if (dead || closing) return;
    if (!events.has(key) && events.size >= MAX_EVENTS) { disconnect('crew: Codex turn event limit exceeded'); return; }
    const keyed = { ...event, text: event.text.slice(-MAX_TEXT), ...(event.kind === 'tool' ? { title: event.title.slice(0, 2000) } : {}), key };
    events.set(key, keyed);
    callbacks.event(keyed);
  }
  function itemEvent(item: ObjectValue, activeTurn: string, completed: boolean): void {
    const id = string(item.id), type = string(item.type);
    if (!id) return;
    const key = `codex:${sessionId}:${activeTurn}:${id}`;
    if (type === 'agentMessage') { emit(key, { kind: 'assistant', text: string(item.text), streaming: !completed }); return; }
    const toolState = !completed ? 'running' : item.status === 'failed' || item.status === 'declined' || item.success === false || item.error ? 'failed' : 'completed';
    let title: string, text: string;
    switch (type) {
      case 'commandExecution': title = string(item.command) || 'Command'; text = string(item.aggregatedOutput); break;
      case 'fileChange': title = 'File changes'; text = array(item.changes).map(value => { const change = object(value); return `${string(change.path)}\n${string(change.diff)}`; }).join('\n'); break;
      case 'mcpToolCall': title = `${string(item.server)} / ${string(item.tool)}`; text = array(object(item.result).content).map(value => string(object(value).text)).filter(Boolean).join('\n') || string(object(item.error).message); break;
      case 'dynamicToolCall': title = string(item.tool) || 'Tool'; text = array(item.contentItems).map(value => string(object(value).text)).filter(Boolean).join('\n'); break;
      case 'collabAgentToolCall': title = string(item.tool) || 'Agent tool'; text = array(item.receiverThreadIds).map(string).join(', '); break;
      case 'webSearch': title = 'Web search'; text = string(item.query) || string(object(item.action).query); break;
      case 'imageView': title = 'View image'; text = string(item.path); break;
      default: return; // Includes reasoning, plans, raw response items and hook prompts.
    }
    const previous = events.get(key);
    if (!text && previous?.kind === 'tool') text = previous.text;
    emit(key, { kind: 'tool', title, text, state: toolState });
  }
  function startTurn(turn: ObjectValue): void {
    const id = string(turn.id);
    if (!id) throw new Error('crew: Codex returned a turn without an id');
    if (terminalTurns.has(id)) return; // Completion can arrive before the RPC response.
    if (turnId !== id) {
      for (const [key, request] of requests) if (request.turnId !== id) cancel(key);
      events.clear();
      turnId = id; identity();
    }
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
      notification('turn/completed', { threadId: sessionId, turn }); return;
    }
    currentState();
  }
  function serverRequest(id: RpcId, method: string, params: ObjectValue, bytes: number): void {
    if (params.threadId !== sessionId || (params.turnId && params.turnId !== turnId) || !turnId) {
      void write({ id, error: { code: -32600, message: 'Request does not belong to the current turn' } }).catch(() => {});
      return;
    }
    if (requestKeys.has(id)) return;
    if (requests.size >= MAX_EVENTS || requestBytes + bytes > MAX_FRAME_BYTES) { disconnect('crew: Codex pending request limit exceeded'); return; }
    // Per-connection, per-occurrence IDs prevent old browser answers being applied
    // after resume or when a provider reuses an RPC ID in a later prompt.
    const key = `codex:${instance}:${++requestSequence}:${typeof id}:${id}`;
    const results = new Map<string, unknown>();
    let request: ConsoleRequest;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const choices = method === 'item/commandExecution/requestApproval' && Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
      const labels: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Deny', cancel: 'Cancel', acceptWithExecpolicyAmendment: 'Allow similar commands', applyNetworkPolicyAmendment: 'Apply network policy' };
      const choicesPublic = choices.map((decision, index) => {
        const name = typeof decision === 'string' ? decision : Object.keys(object(decision))[0] || 'decision';
        const option = typeof decision === 'string' ? decision : `decision-${index}`;
        results.set(option, { decision });
        const details = typeof decision === 'string' ? '' : JSON.stringify(object(decision)[name]);
        return { id: option, label: `${labels[name] || name}${details ? `: ${details}` : ''}` };
      });
      request = { id: key, kind: 'approval', title: method.includes('commandExecution') ? 'Command approval' : 'File change approval', description: [string(params.command), string(params.reason), string(params.grantRoot)].filter(Boolean).join('\n'), options: choicesPublic };
    } else if (method === 'item/permissions/requestApproval') {
      const asked = object(params.permissions);
      const permissions = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null));
      results.set('accept', { permissions, scope: 'turn' });
      results.set('acceptForSession', { permissions, scope: 'session' });
      results.set('decline', { permissions: {}, scope: 'turn' });
      request = { id: key, kind: 'approval', title: 'Additional permissions', description: [string(params.reason), JSON.stringify(permissions)].filter(Boolean).join('\n'), options: [{ id: 'accept', label: 'Allow for turn' }, { id: 'acceptForSession', label: 'Allow for session' }, { id: 'decline', label: 'Deny' }] };
    } else if (method === 'item/tool/requestUserInput') {
      if (array(params.questions).some(value => object(value).isSecret === true)) {
        void write({ id, error: { code: -32602, message: 'Secret questions require a supported secure input surface' } }).catch(() => {}); return;
      }
      const questions = array(params.questions).map(value => {
        const q = object(value);
        return { id: string(q.id), question: string(q.question), ...(Array.isArray(q.options) ? { options: q.options.map(value => { const option = object(value); return { label: string(option.label), ...(typeof option.description === 'string' ? { description: option.description } : {}) }; }) } : {}) };
      });
      if (!questions.length || questions.some(q => !q.id || !q.question)) {
        void write({ id, error: { code: -32602, message: 'Invalid questions' } }).catch(() => {}); return;
      }
      request = { id: key, kind: 'question', title: 'Codex needs input', questions };
    } else {
      void write({ id, error: { code: -32601, message: `Unsupported console request: ${method}` } }).catch(() => {}); return;
    }
    requests.set(key, { rpcId: id, turnId, itemId: string(params.itemId), request, bytes, blocking: request.kind === 'approval' || params.isBlocking !== false, ...(request.kind === 'approval' ? { results } : {}) });
    requestBytes += bytes;
    requestKeys.set(id, key);
    callbacks.request(request); currentState();
  }
  function notification(method: string, params: ObjectValue): void {
    if (params.threadId !== sessionId) return;
    const incomingTurn = string(params.turnId);
    if (method === 'turn/started') { startTurn(object(params.turn)); return; }
    if (method === 'turn/completed') {
      const turn = object(params.turn), id = string(turn.id);
      if (!id) return;
      terminalTurns.add(id);
      if (terminalTurns.size > MAX_HISTORY) terminalTurns.delete(terminalTurns.values().next().value!);
      for (const wake of turnWaiters.get(id) || []) wake();
      turnWaiters.delete(id);
      if (turnId !== id) return;
      for (const value of array(turn.items)) itemEvent(object(value), id, true);
      for (const [key, event] of events) if (event.kind === 'assistant' && event.streaming) emit(key, { kind: 'assistant', text: event.text, streaming: false });
      for (const key of requests.keys()) cancel(key);
      turnId = undefined; identity();
      setState(turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'idle', string(object(turn.error).message) || undefined);
      return;
    }
    if (method === 'serverRequest/resolved') {
      if (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') return;
      const key = requestKeys.get(params.requestId);
      if (!key) return;
      const request = requests.get(key);
      if (request?.replying) { clearTimeout(request.replying.timer); request.replying.resolve(); delete request.replying; }
      cancel(key); currentState(); return;
    }
    if (method === 'thread/status/changed') {
      const status = object(params.status);
      if (status.type === 'notLoaded') disconnect('crew: Codex thread unloaded');
      else if (status.type === 'systemError') setState('failed', 'Codex thread system error');
      else if (status.type === 'active') setState(array(status.activeFlags).some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') || [...requests.values()].some(request => request.blocking) ? 'waiting' : 'running');
      else if (status.type === 'idle' && !turnId && state !== 'interrupted') currentState();
      return;
    }
    if (method === 'thread/closed') { disconnect('crew: Codex thread closed'); return; }
    if (!incomingTurn || incomingTurn !== turnId) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      itemEvent(item, incomingTurn, method === 'item/completed');
      if (method === 'item/completed') {
        let cancelled = false;
        for (const [key, request] of requests) if (request.itemId === item.id) { cancel(key); cancelled = true; }
        if (cancelled) currentState();
      }
    } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const id = string(params.itemId);
      if (!id || typeof params.delta !== 'string') return;
      const key = `codex:${sessionId}:${incomingTurn}:${id}`, previous = events.get(key);
      if (method === 'item/agentMessage/delta') {
        emit(key, { kind: 'assistant', text: (previous?.kind === 'assistant' ? previous.text : '') + params.delta, streaming: true });
      } else emit(key, { kind: 'tool', title: previous?.kind === 'tool' ? previous.title : method.includes('commandExecution') ? 'Command' : 'File changes', text: (previous?.kind === 'tool' ? previous.text : '') + params.delta, state: 'running' });
    }
  }
  function receive(line: string): void {
    if (dead || closing) return;
    try {
      const value = JSON.parse(line) as unknown, wire = object(value);
      if (!Object.keys(wire).length) throw new Error('invalid message');
      if (!wire.method && typeof wire.id === 'number') {
        const call = pending.get(wire.id);
        if (!call) return;
        clearTimeout(call.timer); pending.delete(wire.id);
        if (wire.error) call.reject(new Rejected(string(object(wire.error).message) || 'Codex rejected request'));
        else if ('result' in wire) call.resolve(wire.result);
        else call.reject(new TransportError('crew: invalid Codex response; delivery is unknown', true));
        return;
      }
      const method = string(wire.method);
      if (method.startsWith('item/reasoning/') || method.startsWith('rawResponse')
        || ((method === 'item/started' || method === 'item/completed') && object(object(wire.params).item).type === 'reasoning')) return;
      if (!ready) {
        earlyBytes += Buffer.byteLength(line);
        if (early.length >= MAX_HISTORY || earlyBytes > MAX_EARLY_BYTES) { disconnect('crew: Codex startup event buffer limit exceeded'); return; }
        early.push(wire); return;
      }
      const params = object(wire.params);
      if (typeof wire.id === 'number' || typeof wire.id === 'string') serverRequest(wire.id, method, params, Buffer.byteLength(line));
      else notification(method, params);
    } catch { disconnect('crew: invalid Codex app-server message'); }
  }
  async function launch(): Promise<void> {
    if (closing || dead) throw new Error('crew: Codex adapter is closed or disconnected');
    setState('starting');
    try {
      const env = { ...options.env };
      if (options.child) env.CREW_RUN = options.child.runId; else delete env.CREW_RUN;
      const configured = configuredArgs(options.args || []);
      const args = [...configured.args];
      const access = options.launch.access || 'default';
      const sandbox = access === 'workspace' ? 'workspace-write' : access === 'full' ? 'danger-full-access' : undefined;
      if (sandbox) args.push('-c', `sandbox_mode=${JSON.stringify(sandbox)}`);
      if (options.launch.model) args.push('-c', `model=${JSON.stringify(options.launch.model)}`);
      if (options.launch.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.launch.effort)}`);
      args.push('app-server', '--listen', 'stdio://');
      child = spawn(options.executable || 'codex', args, { cwd: options.launch.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => disconnect(`crew: cannot launch Codex app-server: ${error.message}`));
      child.on('exit', () => disconnect('crew: Codex app-server exited'));
      child.stdin.on('error', () => disconnect('crew: Codex app-server stdin closed'));
      // stderr may include credentials and host diagnostics. Drain it without publishing it.
      child.stderr.resume();
      // readline buffers an unbounded unterminated line. Enforce the frame bound
      // before JSON parsing; setEncoding also handles UTF-8 split across chunks.
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (dead || closing) return;
        buffer += chunk;
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { buffer = ''; disconnect('crew: Codex app-server frame limit exceeded'); return; }
          if (line.trim()) receive(line);
          if (dead) { buffer = ''; return; }
        }
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { buffer = ''; disconnect('crew: Codex app-server frame limit exceeded'); }
      });
      child.stdout.on('end', () => { buffer = ''; disconnect('crew: Codex app-server stdout closed'); });
      child.stdout.on('error', () => { buffer = ''; disconnect('crew: Codex app-server stdout failed'); });
      await rpc('initialize', { clientInfo: { name: 'crew_console', title: 'Crew console', version: '0.15.0' }, capabilities: { experimentalApi: true } });
      await write({ method: 'initialized' });
      provider = recordProcess(child.pid!, process.platform !== 'win32');
      let roots: string[] = [];
      if (access === 'workspace' || configured.roots.length || options.child) {
        const effective = object(object(await rpc('config/read', { cwd: options.launch.cwd, includeLayers: false })).config);
        const existing = array(object(effective.sandbox_workspace_write).writable_roots).filter((value): value is string => typeof value === 'string');
        const extra = [...existing, ...configured.roots];
        roots = access === 'workspace' || options.child ? workspaceRoots(options, extra) : [...new Set(extra.map(path => resolve(options.launch.cwd, path)))];
      }
      const config: ObjectValue = {};
      if (options.launch.mcpServers?.length) config.mcp_servers = codexMcpServers(options.launch.mcpServers);
      if (options.launch.effort) config.model_reasoning_effort = options.launch.effort;
      if (roots.length) config['sandbox_workspace_write.writable_roots'] = roots;
      const params = { cwd: options.launch.cwd, developerInstructions: options.instructions, ...(options.launch.model ? { model: options.launch.model } : {}), ...(sandbox ? { sandbox } : {}), ...(Object.keys(config).length ? { config } : {}) };
      const result = object(await rpc(options.identity ? 'thread/resume' : 'thread/start', { ...params, ...(options.identity ? { threadId: options.identity.sessionId } : {}) }));
      const thread = object(result.thread), id = string(thread.id);
      if (!id || (options.identity && id !== options.identity.sessionId)) throw new Error('crew: Codex returned a different or missing thread identity');
      const status = object(thread.status).type;
      if (status !== 'idle' && status !== 'active') throw new Error('crew: Codex returned an unavailable thread status');
      sessionId = id;
      const active = array(thread.turns).map(object).find(turn => turn.status === 'inProgress');
      if (object(thread.status).type === 'active' && !string(active?.id)) throw new Error('crew: active Codex thread has no current turn id');
      turnId = active ? string(active.id) || undefined : undefined;
      identity(); // Supervisor persists this synchronously before any input is accepted.
      ready = true; currentState();
      earlyBytes = 0;
      for (const wire of early.splice(0)) receive(JSON.stringify(wire));
      if (dead) throw new Error('crew: Codex disconnected during startup');
    } catch (error) {
      if (!child) {
        callbacks.command(options.launch.requestId, 'failed', message(error));
        setState('failed', message(error)); dead = true;
      } else if (!dead) disconnect(message(error));
      try { await shutdown(); }
      catch (cleanup) { throw new Error(`${message(error)}; cleanup failed: ${message(cleanup)}`, { cause: error }); }
      throw error;
    }
  }
  async function doInterrupt(): Promise<void> {
    if (!ready || dead || closing) throw new TransportError('crew: Codex app-server is disconnected', false);
    if (!turnId) return;
    const id = turnId;
    let wake!: () => void;
    const completed = new Promise<void>(resolveDone => { wake = resolveDone; });
    const waiters = turnWaiters.get(id) || new Set<() => void>(); waiters.add(wake); turnWaiters.set(id, waiters);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await rpc('turn/interrupt', { threadId: sessionId, turnId: id });
      await Promise.race([completed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { disconnect('crew: Codex interrupt completion timed out'); reject(new TransportError('crew: interrupt completion is unknown', true)); }, TIMEOUT); })]);
      if (dead) throw new TransportError('crew: Codex disconnected while interrupting', true);
    } finally { clearTimeout(timer); waiters.delete(wake); if (!waiters.size) turnWaiters.delete(id); }
  }
  async function shutdown(): Promise<void> {
    if (provider) return stopPromise ??= (async () => {
      await terminateOwnedProcess(provider);
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once('close', resolve));
    })();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const owned = child;
    return stopPromise ??= new Promise<void>((resolveClosed, rejectClosed) => {
      const hasLiveGroup = (): boolean => execFileSync('ps', ['-ax', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8', timeout: 2000 })
        .trim().split('\n').some(line => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === owned.pid && !state?.startsWith('Z');
        });
      const kill = (signal: NodeJS.Signals): void => {
        if (process.platform !== 'win32' && owned.pid) {
          try { process.kill(-owned.pid, signal); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // A startup failure can close stdout before Node reaps the child.
            // Darwin rejects signals to a zombie-only group with EPERM.
            if (code !== 'ESRCH' && !(code === 'EPERM' && !hasLiveGroup())) throw error;
          }
        } else owned.kill(signal);
      };
      const closed = (): void => { clearTimeout(timer); resolveClosed(); };
      const signal = (value: NodeJS.Signals): void => {
        try { kill(value); }
        catch (error) { clearTimeout(timer); owned.off('close', closed); rejectClosed(error); }
      };
      const timer = setTimeout(() => signal('SIGKILL'), 1000);
      owned.once('close', closed);
      signal('SIGTERM');
    }).catch(error => { stopPromise = undefined; throw error; });
  }
  return {
    capabilities: { activeInput: 'steer', interrupt: true, approvals: true, questions: true },
    start() { return startPromise ??= launch(); },
    send(text, requestId, interrupt = false) {
      const existing = commands.get(requestId); if (existing) return existing;
      callbacks.command(requestId, 'queued');
      // Retain accepted IDs for idempotency. Refuse new IDs at the bound rather
      // than evicting an old ID and accidentally replaying its input later.
      if (commands.size >= MAX_HISTORY) {
        callbacks.command(requestId, 'failed', 'crew: Codex command history limit reached; resume with a new connection');
        return Promise.resolve('failed');
      }
      const result = serialize(async (): Promise<CommandState> => {
        let inputAttempted = false;
        try {
          if (!ready || dead || closing) throw new TransportError('crew: Codex app-server is disconnected', false);
          if (interrupt) await doInterrupt();
          const activeId = turnId;
          const params = { threadId: sessionId, clientUserMessageId: requestId, input: [{ type: 'text', text, text_elements: [] }], ...(activeId ? { expectedTurnId: activeId } : {}) };
          inputAttempted = true;
          const response = object(await rpc(activeId ? 'turn/steer' : 'turn/start', params));
          if (activeId) {
            if (response.turnId !== activeId) throw new TransportError('crew: unexpected steer response; delivery is unknown', true);
          } else {
            if (!string(object(response.turn).id)) throw new TransportError('crew: invalid turn response; delivery is unknown', true);
            startTurn(object(response.turn));
          }
          callbacks.command(requestId, 'delivered'); return 'delivered';
        } catch (error) {
          const status = inputAttempted && error instanceof TransportError && error.transmitted ? 'uncertain' : 'failed';
          if (status === 'uncertain' && !dead) disconnect(message(error));
          callbacks.command(requestId, status, message(error)); return status;
        }
      });
      commands.set(requestId, result); return result;
    },
    interrupt() { return serialize(doInterrupt); },
    async answer(answer: ConsoleAnswer) {
      callbacks.command(answer.requestId, 'queued');
      let transmitted = false;
      try {
        const request = requests.get(answer.pendingRequestId);
        if (!request || request.turnId !== turnId || request.replying || dead || closing) throw new Error('crew: stale or already answered Codex request');
        let result: unknown;
        if (request.request.kind === 'approval') {
          if (!answer.option || !request.results?.has(answer.option)) throw new Error('crew: invalid Codex approval decision');
          result = request.results.get(answer.option);
        } else {
          const answers: Record<string, { answers: string[] }> = Object.create(null);
          for (const question of request.request.questions) {
            const value = answer.answers?.[question.id];
            const values = typeof value === 'string' ? [value] : value;
            if (!values?.length || values.some(value => typeof value !== 'string')) throw new Error(`crew: missing answer for ${question.id}`);
            answers[question.id] = { answers: values };
          }
          result = { answers };
        }
        const resolved = new Promise<void>((resolveAnswer, reject) => {
          const timer = setTimeout(() => disconnect('crew: Codex answer resolution timed out; delivery is unknown'), TIMEOUT);
          request.replying = { resolve: resolveAnswer, reject, timer };
        });
        transmitted = true;
        void write({ id: request.rpcId, result }).catch(error => {
          if (request.replying) { clearTimeout(request.replying.timer); request.replying.reject(error); delete request.replying; }
        });
        await resolved;
        callbacks.command(answer.requestId, 'delivered');
      } catch (error) { callbacks.command(answer.requestId, transmitted ? 'uncertain' : 'failed', message(error)); throw error; }
    },
    close() {
      return closePromise ??= (async () => { closing = true; disconnect('crew: Codex console closed'); await shutdown(); setState('closed'); })()
        .catch(error => { closePromise = undefined; throw error; });
    },
  };
}
