import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ConsoleHostAdapter, HostOptions } from './console-host.ts';
import type { ConsoleAnswer, ConsoleRequest, ConsoleState, CommandState } from './console-types.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT = 30_000;
const MAX_TEXT = 24_000;
const MAX_FRAME = 1024 * 1024;
const MAX_QUEUE = 16;
const MAX_BLOCKS = 128;
const TRUNCATED = '\n[Output truncated]';
const preview = (value: string): string => value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT - TRUNCATED.length) + TRUNCATED;

interface PendingControl { resolve(value: ObjectValue): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface PendingInput { text: string; requestId: string; queued?: true }
interface PendingAck { requestId: string; uuid: string; resolve(delivered: boolean): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface PendingRequest { wireId: string; input: ObjectValue; public: ConsoleRequest }
interface Block { kind: 'text' | 'tool'; key: string; text: string; title: string }

/** Raw print-mode protocol, following Anthropic's query.py and subprocess_cli.py.
 * The supervisor persists callbacks; this adapter never reads/replays transcripts. */
export function createClaudeHost(options: HostOptions & { args?: string[] }): ConsoleHostAdapter {
  const cb = options.callbacks;
  const sessionId = options.identity?.sessionId ?? randomUUID();
  let child: ChildProcessWithoutNullStreams | undefined;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let interruptPromise: Promise<void> | undefined;
  let state: ConsoleState = 'starting';
  let ready = false;
  let closing = false;
  let failure: Error | undefined;
  let busy = false;
  let interrupting = false;
  let turnEnded = false;
  let hostStateSeen = false;
  let hostIdle = true;
  let awaitingAck: PendingAck | undefined;
  let blockCount = 0;
  let idleWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  const queue: PendingInput[] = [];
  const controls = new Map<string, PendingControl>();
  const requests = new Map<string, PendingRequest>();
  const seenRequests = new Set<string>();
  const messages = new Map<string, Map<number, Block>>();
  const streams = new Map<string, string>();
  const tools = new Map<string, Block>();

  function setState(next: ConsoleState, error?: string): void {
    state = next;
    cb.state(next, error);
  }
  function cancelRequests(): void {
    for (const id of requests.keys()) cb.cancelRequest(id);
    requests.clear();
  }
  function finishStreams(): void {
    for (const blocks of messages.values()) for (const block of blocks.values()) {
      if (block.kind === 'text') cb.event({ kind: 'assistant', key: block.key, text: block.text, streaming: false });
    }
    messages.clear(); streams.clear(); blockCount = 0;
  }
  function kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!child?.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
    }
    child.kill(signal);
  }
  function fail(error: Error, disconnected = false): void {
    if (failure || closing) return;
    failure = error; ready = false;
    finishStreams(); cancelRequests();
    for (const pending of controls.values()) { clearTimeout(pending.timer); pending.reject(error); }
    controls.clear();
    idleWaiter?.reject(error); idleWaiter = undefined;
    if (awaitingAck) {
      const ack = awaitingAck; awaitingAck = undefined; clearTimeout(ack.timer);
      cb.command(ack.requestId, 'uncertain', error.message); ack.reject(error);
    }
    for (const input of queue.splice(0)) cb.command(input.requestId, 'failed', error.message);
    setState(disconnected ? 'disconnected' : 'failed', error.message);
    kill();
  }
  function available(): void {
    if (failure) throw failure;
    if (closing || !ready || !child || child.stdin.destroyed) throw new Error('Claude transport is not connected');
  }
  function write(value: ObjectValue): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child || child.stdin.destroyed || closing || failure) { reject(failure ?? new Error('Claude stdin is closed')); return; }
      const timer = setTimeout(() => { const error = new Error('Claude stdin write timed out; delivery is uncertain'); fail(error); reject(error); }, TIMEOUT);
      child.stdin.write(JSON.stringify(value) + '\n', error => {
        clearTimeout(timer);
        if (error) { fail(error); reject(error); } else resolve();
      });
    });
  }
  async function control(request: ObjectValue): Promise<ObjectValue> {
    const requestId = randomUUID();
    const response = new Promise<ObjectValue>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Claude ${string(request.subtype)} response timed out; outcome is uncertain`)), TIMEOUT);
      controls.set(requestId, { resolve, reject, timer });
    });
    // Attach the rejection handler before a write can fail and reject all controls.
    const delivery = write({ type: 'control_request', request_id: requestId, request });
    const [, result] = await Promise.all([delivery, response]);
    return result;
  }
  function maybeIdle(): void {
    if (!busy || !turnEnded || (hostStateSeen && !hostIdle) || requests.size || awaitingAck) return;
    busy = false;
    finishStreams();
    idleWaiter?.resolve(); idleWaiter = undefined;
    setState(interrupting ? 'interrupted' : 'idle');
    if (!interrupting) void pump();
  }
  async function deliver(input: PendingInput): Promise<CommandState> {
    busy = true; turnEnded = false; hostIdle = false;
    const turnId = randomUUID();
    cb.identity({ sessionId, turnId });
    setState('running');
    if (!input.queued) cb.command(input.requestId, 'queued');
    let confirmed = false;
    const receipt = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Claude user acknowledgment timed out; input delivery is uncertain')), TIMEOUT);
      awaitingAck = { requestId: input.requestId, uuid: turnId, timer, reject, resolve(delivered) { confirmed = delivered; resolve(); } };
    });
    try {
      await Promise.all([write({ type: 'user', uuid: turnId, session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: input.text } }), receipt]);
      return confirmed ? 'delivered' : 'uncertain';
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      fail(reason);
      return confirmed ? 'delivered' : 'uncertain';
    }
  }
  async function pump(): Promise<void> {
    if (!ready || busy || interrupting || closing || failure || requests.size || !queue.length) return;
    await deliver(queue.shift()!);
  }
  function emit(block: Block, streaming: boolean): void {
    if (block.kind === 'text') cb.event({ kind: 'assistant', key: block.key, text: block.text, streaming });
    else cb.event({ kind: 'tool', key: block.key, title: block.title, text: block.text, state: 'running' });
  }
  function blocksFor(id: string): Map<number, Block> {
    let blocks = messages.get(id);
    if (!blocks) {
      if (messages.size >= MAX_BLOCKS) throw new Error('Claude turn exceeded the public message limit');
      blocks = new Map(); messages.set(id, blocks);
    }
    return blocks;
  }
  function storeBlock(blocks: Map<number, Block>, index: number, block: Block): void {
    if (!blocks.has(index) && ++blockCount > MAX_BLOCKS) throw new Error('Claude turn exceeded the public block limit');
    blocks.set(index, block);
  }
  function toolBlock(value: ObjectValue): Block {
    const id = string(value.id) || randomUUID();
    const previous = tools.get(id);
    if (!previous && tools.size >= MAX_BLOCKS) throw new Error('Claude exceeded the outstanding tool limit');
    const block: Block = previous ?? { kind: 'tool', key: `claude:tool:${id}`, text: '', title: preview(string(value.name) || 'Tool') };
    block.text = preview(JSON.stringify(value.input ?? {})); tools.set(id, block);
    return block;
  }
  function stream(message: ObjectValue): void {
    const event = object(message.event);
    const lane = string(message.parent_tool_use_id);
    if (event.type === 'message_start') {
      const id = string(object(event.message).id) || randomUUID();
      streams.set(lane, id); blocksFor(id); return;
    }
    const id = streams.get(lane);
    if (!id) return;
    const blocks = blocksFor(id);
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const content = object(event.content_block);
      let block: Block;
      if (content.type === 'text') block = { kind: 'text', key: `claude:${id}:${index}`, text: preview(string(content.text)), title: '' };
      else if (content.type === 'tool_use') { block = toolBlock(content); block.text = ''; }
      else return; // Thinking, signatures and hidden content never reach callbacks.
      storeBlock(blocks, index, block); emit(block, true);
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(index), delta = object(event.delta);
      if (!block) return;
      let next: string;
      if (block.kind === 'text' && delta.type === 'text_delta') next = preview(block.text + string(delta.text));
      else if (block.kind === 'tool' && delta.type === 'input_json_delta') next = preview(block.text + string(delta.partial_json));
      else return;
      if (next === block.text) return;
      block.text = next;
      emit(block, true);
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(index); if (block) emit(block, false);
    } else if (event.type === 'message_stop') {
      for (const block of blocks.values()) emit(block, false);
      streams.delete(lane);
    }
  }
  function assistant(message: ObjectValue): void {
    const value = object(message.message);
    const id = string(value.id) || string(message.uuid) || randomUUID();
    const blocks = blocksFor(id);
    array(value.content).forEach((entry, index) => {
      const content = object(entry);
      if (content.type === 'text') {
        // CLI can emit individual completed blocks with the same API message id.
        const text = preview(string(content.text));
        const candidates = [...blocks.values()].filter(b => b.kind === 'text');
        const prefixes = candidates.filter(b => b.text && (text.startsWith(b.text) || b.text.startsWith(text)));
        const matching = candidates.find(b => b.text === text)
          ?? (prefixes.length === 1 ? prefixes[0] : undefined);
        const existing = blocks.get(index);
        const block = matching ?? (existing?.kind === 'text' ? existing : undefined)
          ?? { kind: 'text', key: `claude:${id}:${index}`, text: '', title: '' };
        block.text = text; if (!matching) storeBlock(blocks, index, block); emit(block, false);
      } else if (content.type === 'tool_use') { const block = toolBlock(content); storeBlock(blocks, index, block); emit(block, false); }
    });
  }
  function toolResults(message: ObjectValue): void {
    for (const entry of array(object(message.message).content)) {
      const result = object(entry);
      if (result.type !== 'tool_result') continue;
      const id = string(result.tool_use_id);
      const tool = tools.get(id);
      const text = typeof result.content === 'string' ? result.content
        : array(result.content).map(object).filter(c => c.type === 'text').map(c => string(c.text)).join('\n');
      cb.event({ kind: 'tool', key: tool?.key ?? `claude:tool:${id}`, title: tool?.title ?? 'Tool', text: preview(text),
        state: result.is_error === true ? 'failed' : 'completed' });
      tools.delete(id);
    }
  }
  function publishRequest(message: ObjectValue): void {
    const wireId = string(message.request_id), request = object(message.request);
    if (!wireId) throw new Error('Claude control request has no id');
    if (seenRequests.has(wireId)) return;
    if (seenRequests.size >= 8192 || wireId.length > 256) throw new Error('Claude exceeded the control request identity limit');
    seenRequests.add(wireId);
    const reject = (reason: string) => {
      void write({ type: 'control_response', response: { subtype: 'error', request_id: wireId, error: reason } }).catch(fail);
    };
    if (interrupting) { reject('Claude turn is being interrupted'); return; }
    if (requests.size >= 32) { reject('Too many pending Claude requests'); return; }
    if (request.subtype !== 'can_use_tool') { reject(`Unsupported Claude control request: ${string(request.subtype)}`); return; }
    if (typeof request.tool_name !== 'string' || !request.tool_name || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
      reject('Malformed Claude permission request'); return;
    }
    const id = randomUUID(), input = object(request.input);
    let publicRequest: ConsoleRequest;
    if (request.tool_name === 'AskUserQuestion') {
      const questions = array(input.questions);
      if (!questions.length || questions.some(q => !string(object(q).question))
        || new Set(questions.map(q => string(object(q).question))).size !== questions.length) {
        reject('Malformed Claude questions'); return;
      }
      publicRequest = { id, kind: 'question', title: string(request.title) || 'Claude has questions',
        questions: questions.map((q, index) => {
          const value = object(q);
          return { id: String(index), question: string(value.question), multiSelect: value.multiSelect === true,
            options: array(value.options).map(o => { const option = object(o); return {
              label: string(option.label), description: string(option.description),
            }; }) };
        }) };
    } else publicRequest = { id, kind: 'approval', title: string(request.title) || `Allow ${string(request.tool_name)}?`,
      description: preview([string(request.description), string(request.decision_reason), JSON.stringify(input, null, 2)].filter(Boolean).join('\n')),
      options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] };
    requests.set(id, { wireId, input, public: publicRequest });
    setState('waiting'); cb.request(publicRequest);
  }
  function receive(value: unknown): void {
    if (closing || failure) return;
    const message = object(value);
    const recorded = string(message.session_id);
    if (recorded && recorded !== sessionId) throw new Error('Claude returned a different session identity; refusing to continue');
    if (message.type === 'control_response') {
      const response = object(message.response), id = string(response.request_id), pending = controls.get(id);
      if (!pending) return;
      controls.delete(id); clearTimeout(pending.timer);
      if (response.subtype === 'error') pending.reject(new Error(string(response.error) || 'Claude control request failed'));
      else if (response.subtype === 'success') pending.resolve(object(response.response));
      else pending.reject(new Error('Malformed Claude control response'));
    } else if (message.type === 'control_request') publishRequest(message);
    else if (message.type === 'control_cancel_request') {
      const cancelled = string(message.request_id);
      if (cancelled) {
        if (cancelled.length > 256 || !seenRequests.has(cancelled) && seenRequests.size >= 8192) throw new Error('Claude exceeded the control request identity limit');
        seenRequests.add(cancelled);
      }
      for (const [id, request] of requests) if (request.wireId === message.request_id) {
        requests.delete(id); cb.cancelRequest(id);
      }
      if (!requests.size && state === 'waiting') setState(busy ? 'running' : 'idle');
      maybeIdle();
    } else if (message.type === 'stream_event') stream(message);
    else if (message.type === 'assistant') assistant(message);
    else if (message.type === 'user') {
      const value = object(message.message);
      if (awaitingAck && message.session_id === sessionId && message.uuid === awaitingAck.uuid && value.role === 'user'
        && !array(value.content).some(c => object(c).type === 'tool_result')) {
        const ack = awaitingAck; awaitingAck = undefined; clearTimeout(ack.timer);
        ack.resolve(true); cb.command(ack.requestId, 'delivered'); maybeIdle();
      }
      toolResults(message);
    }
    else if (message.type === 'system' && message.subtype === 'session_state_changed') {
      hostStateSeen = true; hostIdle = message.state === 'idle';
      if (message.state === 'running' && !busy) { busy = true; turnEnded = false; setState('running'); }
      maybeIdle();
    } else if (message.type === 'result') {
      cancelRequests(); turnEnded = true;
      if (message.is_error) {
        const error = string(message.result) || array(message.errors).map(string).join('\n') || `Claude turn failed: ${string(message.subtype)}`;
        if (!ready) throw new Error(error);
        cb.event({ kind: 'status', text: preview(error) });
      }
      maybeIdle();
    }
  }
  function args(): string[] {
    const configured = options.args ?? [];
    const owned = new Set(['--print', '-p', '--input-format', '--output-format', '--include-partial-messages', '--verbose',
      '--session-id', '--resume', '-r', '--continue', '-c', '--fork-session', '--no-session-persistence',
      '--append-system-prompt', '--system-prompt', '--system-prompt-snapshot', '--replay-user-messages', '--permission-prompts', '--permission-prompt-tool']);
    for (const arg of configured) if (owned.has(arg.split('=')[0]!)) throw new Error(`Claude configured argument conflicts with console transport: ${arg}`);
    let extra = [...configured];
    if (options.launch.access === 'full') {
      extra = [];
      for (let i = 0; i < configured.length; i++) {
        const arg = configured[i]!;
        if (arg === '--permission-mode') { i++; continue; }
        if (arg.startsWith('--permission-mode=') || ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--restricted'].includes(arg)) continue;
        extra.push(arg);
      }
      extra.push('--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions');
    }
    return [...extra, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
      options.identity ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
      '--append-system-prompt', options.instructions, '--system-prompt-snapshot', 'off',
      ...(options.launch.model ? ['--model', options.launch.model] : []),
      ...(options.launch.effort ? ['--effort', options.launch.effort] : [])];
  }
  async function start(): Promise<void> {
    try {
      if (closing) throw new Error('Claude adapter is closed');
      if (!uuid.test(sessionId)) throw new Error('Claude requires an exact recorded UUID session identity');
      if (options.launch.access === 'workspace') throw new Error('Claude workspace confinement is unsupported: permission modes and the Bash sandbox are not a general workspace filesystem boundary');
      const argv = args();
      setState('starting'); cb.identity({ sessionId }); // Persist before human input.
      const env: NodeJS.ProcessEnv = { ...options.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' };
      delete env.CREW_RUN;
      child = spawn(options.executable ?? 'claude', argv, { cwd: options.launch.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', error => fail(error));
      child.stdout.on('error', error => fail(error, true));
      child.stderr.on('error', error => fail(error, true));
      // Drain stderr without publishing host diagnostics or authentication details.
      child.stderr.resume();
      child.once('error', error => fail(error));
      child.once('exit', (code, signal) => { if (!closing) fail(new Error(`Claude process exited (${signal ?? code}); connection lost`), code === 0); });
      let pendingLine = '';
      function line(line: string): void {
        if (line.length > MAX_FRAME) { fail(new Error('Claude stream frame exceeded 1,048,576 characters')); return; }
        if (!line.trim() || !line.trimStart().startsWith('{')) return;
        try { receive(JSON.parse(line)); } catch (error) {
          fail(error instanceof Error && !(error instanceof SyntaxError) ? error : new Error('Invalid Claude stream JSON'));
        }
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure || closing) return;
        pendingLine += chunk;
        let end: number;
        while ((end = pendingLine.indexOf('\n')) >= 0) {
          line(pendingLine.slice(0, end)); pendingLine = pendingLine.slice(end + 1);
          if (failure || closing) { pendingLine = ''; return; }
        }
        if (pendingLine.length > MAX_FRAME) { pendingLine = ''; fail(new Error('Claude stream frame exceeded 1,048,576 characters')); }
      });
      child.stdout.once('end', () => {
        if (pendingLine.trim()) line(pendingLine);
        pendingLine = '';
        if (!closing) fail(new Error('Claude stdout disconnected'), true);
      });
      await control({ subtype: 'initialize', hooks: null });
      if (failure || closing) throw failure ?? new Error('Claude closed during initialization');
      ready = true;
      setState(requests.size ? 'waiting' : busy ? 'running' : 'idle');
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      cb.command(options.launch.requestId, child ? 'uncertain' : 'failed', reason.message); fail(reason);
      throw reason;
    }
  }
  async function interrupt(): Promise<void> {
    available();
    interrupting = true; cancelRequests();
    if (awaitingAck) {
      const ack = awaitingAck; awaitingAck = undefined; clearTimeout(ack.timer);
      cb.command(ack.requestId, 'uncertain', 'Interrupted before native Claude acknowledgment');
      ack.resolve(false);
    }
    for (const input of queue.splice(0)) cb.command(input.requestId, 'failed', 'Cancelled by explicit Claude interrupt');
    const wait = busy ? new Promise<void>((resolve, reject) => { idleWaiter = { resolve, reject }; }) : Promise.resolve();
    const timer = setTimeout(() => fail(new Error('Claude interrupt did not reach idle; outcome is uncertain')), TIMEOUT);
    try {
      await Promise.all([control({ subtype: 'interrupt' }), wait]);
      if (failure || closing) throw failure ?? new Error('Claude closed during interruption');
      setState('interrupted');
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error)); fail(reason); throw reason;
    } finally { clearTimeout(timer); interrupting = false; }
  }
  const doInterrupt = (): Promise<void> => {
    if (!interruptPromise) interruptPromise = interrupt().finally(() => { interruptPromise = undefined; });
    return interruptPromise;
  };
  return {
    capabilities: { activeInput: 'queue', interrupt: true, approvals: true, questions: true },
    start() { return startPromise ??= start(); },
    async send(text, requestId, shouldInterrupt = false) {
      let attemptedInterrupt = false;
      try {
        available();
        if (text.length > MAX_TEXT) throw new Error('Claude input exceeds 24,000 characters');
        if (shouldInterrupt) {
          attemptedInterrupt = true;
          await doInterrupt();
          // The interrupt cancels old queued turns; this human input resumes work.
          if (!busy) return await deliver({ text, requestId });
          if (queue.length >= MAX_QUEUE) throw new Error('Claude input queue is full');
          queue.unshift({ text, requestId, queued: true }); cb.command(requestId, 'queued'); return 'queued';
        }
        if (busy || interrupting || queue.length || requests.size) {
          if (queue.length >= MAX_QUEUE) throw new Error('Claude input queue is full');
          queue.push({ text, requestId, queued: true }); cb.command(requestId, 'queued'); void pump(); return 'queued';
        }
        return await deliver({ text, requestId });
      } catch (error) {
        cb.command(requestId, attemptedInterrupt ? 'uncertain' : 'failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    interrupt: doInterrupt,
    async answer(answer: ConsoleAnswer) {
      let attempted = false;
      try {
        available();
        const pending = requests.get(answer.pendingRequestId);
        if (!pending) throw new Error('Claude request is stale or cancelled');
        let response: ObjectValue;
        if (pending.public.kind === 'approval') {
          if (answer.option === 'allow') response = { behavior: 'allow', updatedInput: pending.input };
          else if (answer.option === 'deny') response = { behavior: 'deny', message: 'User denied this action' };
          else throw new Error('Invalid Claude approval option');
        } else {
          // Question text is provider-controlled and may be a prototype key.
          const answers = Object.create(null) as Record<string, string | string[]>;
          const questions = pending.public.questions;
          if (!answer.answers || Object.keys(answer.answers).some(id => !questions.some(q => q.id === id))) throw new Error('Invalid Claude question answers');
          for (const question of questions) {
            const value = answer.answers[question.id];
            if (typeof value === 'string' ? !value.trim() : !question.multiSelect || !Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error('Every Claude question requires an answer');
            answers[question.question] = value as string | string[];
          }
          response = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
        }
        // Consume before writing, so duplicate or concurrent replies fail closed.
        requests.delete(answer.pendingRequestId); cb.cancelRequest(answer.pendingRequestId);
        attempted = true;
        await write({ type: 'control_response', response: { subtype: 'success', request_id: pending.wireId, response } });
        if (failure || closing) throw failure ?? new Error('Claude closed before answer delivery completed');
        cb.command(answer.requestId, 'delivered');
        setState(requests.size ? 'waiting' : busy ? 'running' : 'idle'); maybeIdle();
      } catch (error) {
        cb.command(answer.requestId, attempted ? 'uncertain' : 'failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    close() {
      return closePromise ??= (async () => {
        closing = true; ready = false; cancelRequests(); finishStreams();
        const error = new Error('Claude transport closed');
        for (const pending of controls.values()) { clearTimeout(pending.timer); pending.reject(error); }
        controls.clear(); idleWaiter?.reject(error); idleWaiter = undefined;
        if (awaitingAck) {
          const ack = awaitingAck; awaitingAck = undefined; clearTimeout(ack.timer);
          cb.command(ack.requestId, 'uncertain', error.message); ack.reject(error);
        }
        for (const input of queue.splice(0)) cb.command(input.requestId, 'failed', error.message);
        if (child && child.exitCode === null && child.signalCode === null) {
          const ownedChild = child;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { kill('SIGKILL'); }, 1_000);
            const deadline = setTimeout(() => {
              clearTimeout(timer);
              const error = new Error('Claude process did not close; outcome is uncertain');
              setState('disconnected', error.message); reject(error);
            }, 5_000);
            ownedChild.once('close', () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
            ownedChild.stdin.end(); kill();
          });
        }
        setState('closed');
      })();
    },
  };
}
