import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';
import { DashboardObserver, parseOutput, readTail } from '../src/dashboard-observe.ts';
import { createDashboardServer } from '../src/dashboard.ts';
import type { RunMeta } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'crew-dashboard-test-'));
const roots = { crew: join(dir, 'crew'), codex: join(dir, 'codex'), claude: join(dir, 'claude') };
const session = '11111111-1111-4111-8111-111111111111';
const rootSession = '22222222-2222-4222-8222-222222222222';
const parent = `codex-${rootSession}`;
// A future adapter must still never invoke the user's host tools from these tests.
mkdirSync(join(dir, 'bin'));
for (const bin of ['herdr', 'claude', 'codex']) {
  const path = join(dir, 'bin', bin);
  writeFileSync(path, '#!/bin/sh\necho "unexpected host invocation" >&2\nexit 99\n'); chmodSync(path, 0o755);
}
process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`;
process.env.CREW_HOME = roots.crew;
process.env.CODEX_HOME = roots.codex;
process.env.CLAUDE_CONFIG_DIR = roots.claude;
process.env.CREW_CONFIG = join(dir, 'config.json');
process.env.CREW_ROSTER = join(dir, 'roster.json');
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { for (const root of Object.values(roots)) { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); } });

function write(path: string, text: string): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
function run(overrides: Partial<RunMeta> = {}): RunMeta {
  const value: RunMeta = {
    id: 'b-worker', name: 'test-worker', role: 'builder', route: { host: 'codex', model: 'test-model', effort: 'high', strategy: 'pinned' },
    cwd: '/project', parent: { mailbox: parent, host: 'codex', threadId: rootSession }, createdAt: '2026-10-05T12:00:00.000Z',
    state: 'running', launcher: 'herdr', keep: true, threadId: session, sessionId: session,
    launch: { args: ['secret argument'], env: { PRIVATE_TOKEN: 'never send me' } }, ...overrides,
  };
  write(join(roots.crew, 'runs', value.id, 'meta.json'), JSON.stringify(value)); return value;
}
const message = (text: string) => JSON.stringify({ timestamp: '2026-10-05T12:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
const transcript = () => join(roots.codex, 'sessions', '2026', '10', '05', `rollout-${session}.jsonl`);

it('projects nested ownership, preserves recorded state, and never exposes launch settings', () => {
  run({ id: 'a-advisor', role: 'advisor' });
  run({ parent: { mailbox: 'a-advisor', name: 'advisor', host: 'codex' }, state: 'done', settled: { at: '2026-10-05', hash: 'a', status: 'DONE' } });
  write(join(roots.codex, 'session_index.jsonl'), JSON.stringify({ id: rootSession, thread_name: 'Real workstream title' }) + '\n');
  const result = new DashboardObserver(roots).snapshot();
  assert.equal(result.workstreams.length, 1);
  assert.equal(result.workstreams[0]?.name, 'Real workstream title');
  assert.equal(result.workstreams[0]?.runs, 2);
  assert.equal(result.workstreams[0]?.running, 1);
  assert.equal(result.nodes.find(n => n.id === 'b-worker')?.parentId, 'a-advisor');
  assert.equal(result.nodes.find(n => n.id === parent)?.state, 'untracked');
  assert.equal(result.nodes.find(n => n.id === 'b-worker')?.state, 'done');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|secret argument|never send me/);
});

it('reads a Herdr member from its native transcript without host IPC or mailbox consumption', () => {
  run();
  write(transcript(), message('Actual agent output'));
  const mailbox = join(roots.crew, 'mail', 'b-worker');
  write(join(mailbox, 'inbox.jsonl'), JSON.stringify({ id: 'm', at: 'now', kind: 'message', from: { name: 'parent' }, text: 'keep going' }) + '\n');
  write(join(mailbox, 'cursor'), '0');
  write(join(roots.crew, 'runs', 'b-worker', 'packet.md'), 'Do the scoped work.');
  write(join(roots.crew, 'runs', 'b-worker', 'result.md'), '# Status\nIN PROGRESS');
  const metaPath = join(roots.crew, 'runs', 'b-worker', 'meta.json');
  const before = readFileSync(metaPath, 'utf8');
  const observer = new DashboardObserver(roots); observer.snapshot();
  const detail = observer.detail('b-worker')!;
  assert.equal(detail.source, 'codex-session');
  assert.equal(detail.events[0]?.text, 'Actual agent output');
  assert.equal(detail.packet, 'Do the scoped work.');
  assert.match(detail.result, /IN PROGRESS/);
  assert.equal(detail.messages[0]?.text, 'keep going');
  assert.equal(readFileSync(join(mailbox, 'cursor'), 'utf8'), '0');
  assert.equal(readFileSync(metaPath, 'utf8'), before);
  assert.equal(observer.detail('../../private'), undefined);
});

it('omits reasoning, instruction context and mirrored events while retaining public tool output', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'hidden reasoning' }], encrypted_content: 'ciphertext' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'mirror' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Passed\n15 tests' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n' + message('Public explanation');
  const events = parseOutput(rows, 'codex-session');
  assert.deepEqual(events.map(e => e.kind), ['tool', 'result', 'message']);
  assert.equal(events[1]?.text, 'Passed\n15 tests');
  assert.doesNotMatch(JSON.stringify(events), /hidden reasoning|ciphertext|injected context|mirror/);
});

it('reads Claude text, tool use and tool results without exposing thinking blocks', () => {
  run({ route: { host: 'claude', model: 'test', effort: 'high', strategy: 'pinned' } });
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Checking the boundary' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Tests passed' }] }] } },
  ];
  write(join(roots.claude, 'projects', '-project', `${session}.jsonl`), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const observer = new DashboardObserver(roots); observer.snapshot();
  const detail = observer.detail('b-worker')!;
  assert.equal(detail.source, 'claude-session');
  assert.deepEqual(detail.events.map(e => e.kind), ['message', 'tool', 'result']);
  assert.doesNotMatch(JSON.stringify(detail), /private/);
});

it('renders Codex shell envelopes with real line breaks while preserving arbitrary JSON output', () => {
  const output = [
    { type: 'text', text: 'Script completed' },
    { type: 'text', text: JSON.stringify({ chunk_id: 'abc', wall_time_seconds: 1, exit_code: 0, output: 'first line\nsecond line' }) },
    { type: 'text', text: '{"output":"ordinary JSON"}' },
  ];
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output } });
  assert.equal(parseOutput(row, 'codex-session')[0]?.text, 'Script completed\nExit 0\nfirst line\nsecond line\n{"output":"ordinary JSON"}');
});

it('reads bounded complete lines, follows appends, and handles replacement and unknown sources', () => {
  run();
  const path = join(roots.crew, 'runs', 'b-worker', 'exec.log');
  write(path, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'exec output' } }) + '\n');
  const observer = new DashboardObserver(roots); observer.snapshot();
  assert.equal(observer.detail('b-worker')?.events[0]?.text, 'exec output');
  const text = message('new output'); appendFileSync(path, text.slice(0, -2));
  assert.equal(observer.detail('b-worker')?.events.length, 1);
  appendFileSync(path, text.slice(-2));
  assert.equal(observer.detail('b-worker')?.events.at(-1)?.text, 'new output');
  writeFileSync(path, message('replacement'));
  assert.deepEqual(observer.detail('b-worker')?.events.map(e=>e.text), ['replacement']);
  writeFileSync(path, 'x'.repeat(200) + '\n' + message('small'));
  const tail = readTail(path, true, message('small').length + 5);
  assert.equal(tail.text, message('small')); assert.equal(tail.truncated, true);
  rmSync(path);
  assert.equal(observer.detail('b-worker')?.source, 'unavailable');
});

it('isolates corrupt metadata and detects cyclic ownership', () => {
  run({ id: 'b-one', parent: { mailbox: 'b-two', host: 'codex' } });
  run({ id: 'b-two', parent: { mailbox: 'b-one', host: 'codex' } });
  write(join(roots.crew, 'runs', 'b-broken', 'meta.json'), '{bad');
  const snapshot = new DashboardObserver(roots).snapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert(snapshot.warnings.some(w => w.includes('b-broken')));
  assert(snapshot.warnings.some(w => w.includes('Cyclic')));
});

it('ignores native subagent result folders without hiding malformed run metadata', () => {
  run();
  write(join(roots.crew, 'runs', 'claude-native', 'result.md'), 'DONE');
  write(join(roots.crew, 'runs', 'b-empty', 'meta.json'), '');
  const snapshot = new DashboardObserver(roots).snapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(snapshot.warnings, ['Run b-empty has unreadable metadata.']);
});

it('serves a local read-only API, blocks cross-site/host requests and streams growing output', async () => {
  run(); write(transcript(), message('first'));
  const server = createDashboardServer(new DashboardObserver(roots), 15);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  try {
    const home = await fetch(url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(await home.text(), /Crew — workstreams/);
    assert.equal((await fetch(url + '/api/snapshot', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + '/api/snapshot', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(url + '/api/snapshot', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(url + '/api/snapshot', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/api/detail?node=..%2F..%2Fprivate')).status, 404);
    const response = await fetch(url + '/api/events?node=b-worker', { signal: abort.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const readUntil = async (text: string): Promise<string> => {
      let output = '';
      const timeout = setTimeout(() => abort.abort(), 3_000);
      try {
        while (!output.includes(text)) { const next = await reader.read(); assert(!next.done); output += new TextDecoder().decode(next.value); }
        return output;
      } finally { clearTimeout(timeout); }
    };
    assert.match(await readUntil('first'), /event: update/);
    appendFileSync(transcript(), message('second-live-message'));
    assert.match(await readUntil('second-live-message'), /codex-session/);
    assert.equal(readFileSync(join(roots.crew, 'runs', 'b-worker', 'meta.json'), 'utf8').includes('"state":"running"'), true);
  } finally {
    abort.abort();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
