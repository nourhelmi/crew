import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Isolated stdio peer: no Codex executable, credentials, state or model calls.
const log = process.env.FAKE_CODEX_LOG!;
const scenario = (): Record<string, unknown> => JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO!, 'utf8'));
const record = (value: object) => appendFileSync(log, JSON.stringify(value) + '\n');
record({ kind: 'launch', pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), env: { CREW_RUN: process.env.CREW_RUN, CREW_HOME: process.env.CREW_HOME, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME } });
const send = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: object) => send({ method, params });
let threadId = 'thread-new', turnId = '', counter = 0;
let requestId: string | number = 101;
const turn = (id: string, status = 'inProgress', items: object[] = []) => ({ id, status, items, error: null });
const event = (method: string, params: object = {}) => notify(method, { threadId, turnId, ...params });
const finish = (status = 'completed', items: object[] = []) => { event('turn/completed', { turn: turn(turnId, status, items) }); turnId = ''; };
function publish(text: string): void {
  const settings = scenario();
  if (text === 'events') {
    event('item/started', { item: { id: 'answer', type: 'agentMessage', text: '' } });
    event('item/agentMessage/delta', { itemId: 'answer', delta: 'hel' });
    event('item/agentMessage/delta', { itemId: 'answer', delta: 'lo' });
    event('item/started', { item: { id: 'reason', type: 'reasoning', content: ['SECRET_REASONING'], summary: ['SECRET_REASONING'] } });
    event('item/reasoning/textDelta', { itemId: 'reason', delta: 'SECRET_REASONING' });
    event('item/reasoning/summaryTextDelta', { itemId: 'reason', delta: 'SECRET_REASONING' });
    event('rawResponseItem/completed', { item: { type: 'reasoning', text: 'SECRET_REASONING' } });
    event('item/started', { item: { type: 'commandExecution', id: 'cmd', command: 'npm test', status: 'inProgress', aggregatedOutput: '' } });
    event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'pass' });
    event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: '\n' });
    event('item/completed', { item: { type: 'commandExecution', id: 'cmd', command: 'npm test', status: 'completed', aggregatedOutput: 'pass\n', exitCode: 0 } });
    event('item/completed', { item: { type: 'fileChange', id: 'patch', changes: [{ path: 'a.ts', diff: '+x' }], status: 'failed' } });
    event('item/completed', { item: { type: 'mcpToolCall', id: 'mcp', server: 'docs', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'tool result' }] } } });
    event('item/completed', { item: { type: 'dynamicToolCall', id: 'dynamic', tool: 'inspect', status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'inspected' }] } });
    event('item/agentMessage/delta', { threadId: 'foreign', itemId: 'foreign', delta: 'FOREIGN_TEXT' });
    event('item/agentMessage/delta', { turnId: 'stale-turn', itemId: 'stale', delta: 'STALE_TEXT' });
    event('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'hello' } });
    finish();
  } else if (text === 'approval' || text === 'question' || text === 'unsupported' || text === 'stale-request') {
    requestId = settings.stringRequestId ? '101' : 101;
    const method = text === 'question' ? 'item/tool/requestUserInput' : text === 'unsupported' ? 'mcpServer/elicitation/request' : settings.approvalMethod || 'item/commandExecution/requestApproval';
    const params = { threadId, turnId: text === 'stale-request' ? 'old-turn' : turnId, itemId: 'approval-tool', command: 'echo ok', reason: 'requested write', permissions: { network: { enabled: true }, fileSystem: null }, questions: [{ id: 'choice', header: 'Choose', question: 'Which?', isOther: true, isSecret: settings.secret === true, options: [{ label: 'One', description: 'first' }, { label: 'Two', description: 'second' }] }], isBlocking: settings.nonBlocking !== true, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } }, 'decline', 'cancel'] };
    send({ id: requestId, method, params });
  } else if (text === 'cancel-request') {
    event('serverRequest/resolved', { requestId });
  } else if (text === 'finish') finish();
  else if (text === 'race-complete') finish();
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const wire = JSON.parse(line), settings = scenario();
  record({ kind: 'wire', ...wire });
  if (!wire.method) {
    if (settings.disconnectAnswers) process.exit(0);
    if ('result' in wire) event('serverRequest/resolved', { requestId: wire.id });
    return;
  }
  const response = (result: object) => send({ id: wire.id, result });
  if (wire.method === 'initialize') { response({ userAgent: 'fake' }); return; }
  if (wire.method === 'initialized') return;
  if (wire.method === 'config/read') { response({ config: { sandbox_workspace_write: { writable_roots: settings.configuredRoots || [], network_access: true } }, origins: {}, layers: null }); return; }
  if (wire.method === 'thread/start' || wire.method === 'thread/resume') {
    threadId = settings.wrongThread ? 'wrong-thread' : wire.params.threadId || 'thread-new';
    turnId = settings.activeResume ? 'turn-resumed' : '';
    response({ thread: { id: threadId, status: { type: settings.activeResume || settings.missingActiveTurn ? 'active' : 'idle', activeFlags: [] }, turns: turnId ? [turn(turnId)] : [] }, sandbox: { type: 'readOnly', networkAccess: false } });
    return;
  }
  if (wire.method === 'turn/start' || wire.method === 'turn/steer') {
    const text = wire.params.input[0].text;
    if (text === 'reject') { send({ id: wire.id, error: { code: -32602, message: 'turn mismatch' } }); return; }
    if (text === 'disconnect') process.exit(0);
    if (text === 'malformed') { response({}); return; }
    if (wire.method === 'turn/start') {
      turnId = `turn-${++counter}`;
      event('turn/started', { turn: turn(turnId) });
      const id = turnId;
      if (text === 'race-complete') publish(text);
      response({ turn: turn(id) });
    } else response({ turnId });
    if (text !== 'race-complete') publish(text);
    return;
  }
  if (wire.method === 'turn/interrupt') {
    if (settings.rejectInterrupt) { send({ id: wire.id, error: { code: -32602, message: 'cannot interrupt' } }); return; }
    if (settings.disconnectInterrupt) process.exit(0);
    response({});
    setTimeout(() => { record({ kind: 'interrupt-completed' }); finish('interrupted'); event('thread/status/changed', { status: { type: 'idle' } }); }, 20);
    return;
  }
  send({ id: wire.id, error: { code: -32601, message: 'unsupported client method' } });
});
input.on('close', () => process.exit(0));
