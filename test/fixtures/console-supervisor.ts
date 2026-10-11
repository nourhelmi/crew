import { appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ConsoleSupervisor } from '../../src/console-supervisor.ts';
import type { HostOptions, ConsoleHostAdapter } from '../../src/console-host.ts';
const path = process.argv[2]!;
const id = basename(path); const root = dirname(dirname(dirname(path)));
const log = (value: unknown): void => appendFileSync(join(path, 'fixture-calls.jsonl'), `${JSON.stringify(value)}\n`);
const factory = (options: HostOptions): ConsoleHostAdapter => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false; let closed = false;
  const sessionId = options.identity?.sessionId ?? `fixture-${id}`;
  const queue: { text: string; id: string }[] = [];
  const pending = new Set<string>();
  const complete = (text: string, requestId: string): void => {
    if (closed) return;
    options.callbacks.event({ kind: 'assistant', key: requestId, text: `Response: ${text}`, streaming: false });
    active = false; options.callbacks.state('idle');
    const next = queue.shift(); if (next) void adapter.send(next.text, next.id);
  };
  const adapter: ConsoleHostAdapter = {
    capabilities: { activeInput: options.launch.host === 'claude' ? 'queue' : 'steer', interrupt: true, approvals: true, questions: true },
    async start() { log({ method: 'start', identity: options.identity, envHasCrewRun: !!options.env.CREW_RUN, instructions: options.instructions }); options.callbacks.identity({ sessionId }); options.callbacks.state('idle'); },
    async send(text, requestId, interrupt) {
      log({ method: 'send', sessionId, text, requestId, interrupt });
      if (closed) throw new Error('Fixture is closed');
      if (interrupt) await adapter.interrupt();
      if (active && options.launch.host === 'claude') { queue.push({ text, id: requestId }); options.callbacks.command(requestId, 'queued'); return 'queued'; }
      active = true; options.callbacks.identity({ sessionId, turnId: `turn-${requestId}` }); options.callbacks.state('running');
      if (text === 'transport-failure') throw new Error('Fixture transport loss after input');
      options.callbacks.command(requestId, 'delivered');
      if (text === 'approval') {
        pending.add('approval-1'); options.callbacks.request({ id: 'approval-1', kind: 'approval', title: 'Execute tool?', description: 'Fixture approval', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] });
      } else if (text === 'question') {
        pending.add('question-1'); options.callbacks.request({ id: 'question-1', kind: 'question', title: 'Choose', questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] }] });
      } else if (text !== 'hold') timer = setTimeout(() => complete(text, requestId), 70);
      return 'delivered';
    },
    async interrupt() { log({ method: 'interrupt' }); if (timer) clearTimeout(timer); active = false; for (const id of pending) options.callbacks.cancelRequest(id); pending.clear(); options.callbacks.state('interrupted'); },
    async answer(answer) { log({ method: 'answer', answer }); if (!pending.delete(answer.pendingRequestId)) throw new Error('Stale fixture request'); options.callbacks.cancelRequest(answer.pendingRequestId); complete('Answered', answer.requestId); },
    async close() { log({ method: 'close' }); closed = true; if (timer) clearTimeout(timer); for (const q of queue) options.callbacks.command(q.id, 'failed', 'Queued input canceled'); queue.length = 0; options.callbacks.state('closed'); },
  };
  return adapter;
};
const keep = setInterval(() => {}, 60_000);
const supervisor = new ConsoleSupervisor(id, { root, factory, onExit: () => clearInterval(keep) });
if (!await supervisor.start()) clearInterval(keep);
process.once('SIGTERM', () => { void supervisor.close(); });
