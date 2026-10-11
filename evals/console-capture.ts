import type { ConsoleCommand, ConsoleDetail, ConsoleLaunch, ConsoleMessage, ConsoleMutation, ConsoleSession, ConsoleUpdate } from '../src/console-types.ts';
import { score, unexecuted } from './score.ts';
import { scenarios } from './scenarios.ts';
import type { AssertionId, Observation, Report } from './scenarios.ts';
import { tinyInstructions, tinyVerifier } from './capture.ts';
import type { Receipt, Run } from './capture.ts';

export interface HttpReceipt {
  method: 'GET' | 'POST'; path: string; at: number; status: number;
  request?: ConsoleLaunch | ConsoleMessage; response: unknown;
}
/** Normalized from the backend's private metadata, never from model prose. */
export interface ConsoleIdentity {
  phase: 'first' | 'second' | 'reconnected';
  session: ConsoleSession;
  providerSessionId?: string;
  commands: Record<string, ConsoleCommand>;
  commandReceipts: Record<string, { requestId: string; phase: string; command: ConsoleCommand;
    intent: { kind: string; payload: ConsoleLaunch | ConsoleMessage } }>;
}
export interface ConsoleCapture {
  files: Record<string, string>;
  beforeSecond: Record<string, string>;
  receipts: Receipt[];
  runs: Run[];
  managedIds: string[];
  /** Real RPC requests captured on the owned app-server stdin, not exec events. */
  providerRequests: { method: string; params: { threadId?: string; clientUserMessageId?: string; input?: { type: string; text: string }[] } }[];
  http: HttpReceipt[];
  identities: ConsoleIdentity[];
  details: { phase: ConsoleIdentity['phase']; detail: ConsoleDetail }[];
  streams: { connection: number; update: ConsoleUpdate }[];
  launch: ConsoleLaunch;
  followup?: { request: ConsoleMessage; nonce: string; generatedAt: number; firstCompletedAt: number };
}

const parse = (text?: string): Record<string, unknown> => {
  try { const value: unknown = JSON.parse(text ?? ''); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Scores normalized console events directly. No invented exec item.completed events. */
export function scoreConsoleCapture(capture: ConsoleCapture, model: string, durationMs: number): Report {
  const facts: Observation['facts'] = {};
  const fact = (id: AssertionId, holds: boolean, detail: string, paths = ['console-capture.json']): void => {
    facts[id] = { holds, kind: 'runtime', detail, paths };
  };
  const first = capture.details.find(d => d.phase === 'first')?.detail;
  const second = capture.details.find(d => d.phase === 'second')?.detail;
  const reconnected = capture.details.find(d => d.phase === 'reconnected')?.detail;
  const firstIdentity = capture.identities.find(d => d.phase === 'first');
  const provider = firstIdentity?.providerSessionId;
  const managed = first?.session.id;
  const root = first?.session.rootNodeId;
  const stable = Boolean(provider && managed && root === `console-${managed}` && first?.session.host === 'codex'
    && capture.identities.length === 3 && new Set(capture.identities.map(i => i.phase)).size === 3
    && capture.identities.every(i => i.providerSessionId === provider && i.session.id === managed && i.session.rootNodeId === root && i.session.host === 'codex')
    && capture.details.length === 3 && capture.details.every(d => d.detail.session.id === managed && d.detail.session.rootNodeId === root));
  fact('console-identity', stable, 'Same managed root and actual provider session through both inputs and reconnect.');

  const greeting = capture.files['workspace/greeting.json'];
  const good = parse(greeting).message === 'Hello world' && parse(greeting).unchanged === 'preserve-me';
  const tool = first?.events.some(e => e.kind === 'tool' && e.state === 'completed') ?? false;
  fact('direct-repair', good && tool, 'Repaired file preserves unrelated data, with a completed normalized native tool event.', ['workspace/greeting.json', 'console-capture.json']);
  const allowed = ['workspace/greeting.json', 'workspace/verify.mjs', 'workspace/AGENTS.md', 'workspace/root-result.md', 'workspace/followup.json'];
  const bounded = capture.files['workspace/verify.mjs'] === tinyVerifier && capture.files['workspace/AGENTS.md'] === tinyInstructions
    && Object.keys(capture.files).filter(p => p.startsWith('workspace/')).every(p => allowed.includes(p));
  fact('bounded-diff', bounded, 'Immutable verifier/instructions and bounded file inventory.');
  const verified = Boolean(stable && good && bounded && capture.receipts.some(r => r.args[0] === 'node'
    && r.caller === `codex-${provider}` && r.exitCode === 0 && r.cwd === 'workspace'
    && ['verify.mjs', './verify.mjs'].includes(r.args[1] ?? '')
    && ['workspace/verify.mjs', 'workspace/greeting.json', 'workspace/AGENTS.md'].every(p => r.before[p] === capture.files[p] && r.after?.[p] === capture.files[p])
    && r.stdout.trim() === 'greeting verified'));
  fact('repair-verified', verified, 'Independent successful node verifier receipt binds identity and immutable input/output bytes.', ['console-capture.json', 'workspace/verify.mjs']);
  fact('no-unnecessary-launch', capture.runs.length === 0 && !capture.receipts.some(r => r.args[0] === 'spawn'), 'No Crew descendants or spawn attempts for the tiny repair.');

  const followup = capture.followup;
  const requestIds = [capture.launch.requestId, followup?.request.requestId];
  const receiptDelivered = (identity: ConsoleIdentity, id: string): boolean => {
    const receipt = identity.commandReceipts[id];
    const expectedKind = id === capture.launch.requestId ? 'launch' : 'message';
    const payload = receipt?.intent.payload;
    return Boolean(receipt?.phase === 'complete' && receipt.requestId === id && receipt.command.requestId === id
      && receipt.command.state === 'delivered' && receipt.intent.kind === expectedKind && payload?.requestId === id
      && (expectedKind === 'launch' ? 'prompt' in payload! && payload.prompt === capture.launch.prompt
        : 'text' in payload! && payload.text === followup?.request.text));
  };
  const delivered = Boolean(followup && requestIds.every(id => id && capture.identities.slice(1).every(i => i.commands[id]?.state === 'delivered'))
    && requestIds.every(id => id && capture.identities.slice(1).every(i => receiptDelivered(i, id)))
    && firstIdentity && receiptDelivered(firstIdentity, capture.launch.requestId)
    && firstIdentity?.commands[capture.launch.requestId]?.state === 'delivered'
    && second?.events.filter(e => e.kind === 'user').length === 2
    && requestIds.every(id => second?.events.some(e => e.kind === 'user' && e.command?.requestId === id && e.command?.state === 'delivered')));
  fact('console-delivery', delivered && stable, 'Durable command receipts and normalized user events show actual delivery to the owned thread.');
  const mutations = capture.http.filter(r => r.method === 'POST' && (r.path === '/api/console/sessions' || r.path.endsWith('/messages')));
  const starts = capture.providerRequests.filter(r => r.method === 'thread/start');
  const turns = capture.providerRequests.filter(r => r.method === 'turn/start');
  const exactWork = capture.managedIds.length === 1 && capture.managedIds[0] === managed
    && starts.length === 1 && turns.length === 2 && capture.providerRequests.length === 3
    && requestIds.every(id => turns.filter(r => r.params.threadId === provider && r.params.clientUserMessageId === id
      && r.params.input?.length === 1 && r.params.input[0]?.type === 'text'
      && r.params.input[0]?.text === (id === capture.launch.requestId ? capture.launch.prompt : followup?.request.text)).length === 1)
    && capture.streams.every(s => s.update.sessions.length === 1 && s.update.sessions[0]?.id === managed);
  const replayed = Boolean(followup && mutations.length === 4 && requestIds.every(id => {
    const requests = mutations.filter(r => r.request?.requestId === id);
    return requests.length === 2 && requests.every(r => r.status >= 200 && r.status < 300)
      && same(requests[0]?.request, requests[1]?.request)
      && requests.every(r => (r.response as ConsoleMutation | undefined)?.session?.id === managed
        && (r.response as ConsoleMutation | undefined)?.session?.rootNodeId === root
        && (r.response as ConsoleMutation | undefined)?.command?.requestId === id);
  }) && second?.events.filter(e => e.kind === 'user').length === 2
    && capture.identities.every(i => Object.keys(i.commands).every(id => requestIds.includes(id)))
    && capture.identities.slice(1).every(i => Object.keys(i.commands).length === 2));
  fact('console-idempotency', replayed && delivered && stable && exactWork, 'Identical request IDs replay twice with one managed root, one actual provider launch and exactly one actual provider input per human request.');

  const preserves = (older: ConsoleDetail | undefined, newer: ConsoleDetail | null | undefined): boolean => Boolean(older && newer
    && older.events.length > 0 && older.events.every(e => newer.events.some(n => n.id === e.id && same(n, e))));
  const streamFirst = capture.streams.filter(s => s.connection === 1).at(-1)?.update.detail;
  const streamSecond = capture.streams.filter(s => s.connection === 2).at(-1)?.update.detail;
  const ordered = (detail: ConsoleDetail | undefined): boolean => Boolean(detail && new Set(detail.events.map(e => e.id)).size === detail.events.length
    && detail.events.every((e, i) => i === 0 || e.sequence > detail.events[i - 1]!.sequence));
  fact('console-reconnect', stable && ordered(first) && ordered(second) && ordered(reconnected)
    && preserves(first, second) && preserves(first, streamFirst) && preserves(second, reconnected) && preserves(second, streamSecond),
  'HTTP detail and two separate SSE connections retain exact ordered conversation history.');
  const human = Boolean(followup && followup.generatedAt >= followup.firstCompletedAt
    && !capture.launch.prompt.includes(followup.nonce) && /^[a-f0-9]{48}$/.test(followup.nonce)
    && followup.request.text.includes(followup.nonce) && !capture.beforeSecond['workspace/followup.json']
    && capture.beforeSecond['workspace/greeting.json'] === greeting
    && first?.session.state === 'idle' && second?.session.state === 'idle'
    && second.events.some(e => e.kind === 'user' && e.text === followup.request.text && e.command?.requestId === followup.request.requestId)
    && first.events.some(e => e.kind === 'user' && e.text === capture.launch.prompt && e.command?.requestId === capture.launch.requestId)
    && mutations.filter(r => r.request?.requestId === followup.request.requestId).every(r => r.at >= followup.generatedAt));
  fact('second-human-input', human && delivered && stable, 'Newly generated nonce is sent as a real second HTTP input after first-turn completion.');
  const artifact = parse(capture.files['workspace/followup.json']);
  fact('nonce-artifact', Boolean(human && verified && artifact.nonce === followup?.nonce && artifact.message === 'Hello world'),
    'Independently parsed second-turn artifact contains the fresh nonce and repaired greeting.', ['workspace/followup.json', 'console-capture.json']);

  const result = score({ case: 'advisor-tiny-repair', surface: 'console-api', facts, launchCount: capture.runs.length }, durationMs);
  return {
    schema: 1, surface: 'console-api', mode: 'live', proof: 'real-provider-tools', model,
    status: result.status === 'pass' ? 'pass' : 'fail', durationMs, launchCount: capture.runs.length,
    evidencePaths: ['console-capture.json', 'workspace/greeting.json', 'workspace/followup.json'],
    cases: [result, ...scenarios.filter(s => s.id !== result.case).map(unexecuted)],
    note: 'Console HTTP/SSE, owned provider identity, immutable verifier and a fresh second human input only. This is API proof; browser behavior and other catalog cases were not executed.',
  };
}
