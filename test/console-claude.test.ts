import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { createClaudeHost } from '../src/console-claude.ts';
import type { HostEvent, HostIdentity, HostOptions } from '../src/console-host.ts';
import type { ConsoleRequest, ConsoleState, CommandState } from '../src/console-types.ts';
import { processExists, processMatches } from '../src/console-process.ts';

type Json = Record<string, any>;
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Fixture did not reach expected state'); await delay(5); }
}
function fixture(t: TestContext, overrides: { mode?: string; identity?: HostIdentity; access?: 'default' | 'workspace' | 'full'; args?: string[]; executable?: string; stateDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-console-claude-'));
  for (const name of ['claude', 'crew', 'codex']) mkdirSync(join(dir, name));
  for (const name of ['input.ndjson', 'output.ndjson']) writeFileSync(join(dir, name), '');
  const executable = join(dir, 'fake-claude');
  const source = fileURLToPath(new URL('./fixtures/console-claude.ts', import.meta.url));
  writeFileSync(executable, `#!${process.execPath}\nimport ${JSON.stringify(source)};\n`, { mode: 0o755 });
  const states: { state: ConsoleState; error?: string | undefined }[] = [];
  const identities: HostIdentity[] = [];
  const events: HostEvent[] = [];
  const currentEvents = new Map<string, HostEvent>();
  const requests = new Map<string, ConsoleRequest>();
  const cancelled: string[] = [];
  const commands: { id: string; state: CommandState; error?: string | undefined }[] = [];
  const options: HostOptions & { args?: string[] } = {
    launch: { cwd: dir, mode: 'cos', host: 'claude', requestId: 'launch', prompt: 'Must not be replayed', model: 'fixture', effort: 'high', access: overrides.access ?? 'default' },
    // No inherited real host state or credential paths, even when a test fails.
    env: { PATH: process.env.PATH, CLAUDE_FIXTURE_DIR: dir, ...(overrides.mode ? { CLAUDE_FIXTURE_MODE: overrides.mode } : {}),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'), CREW_HOME: join(dir, 'crew'), CODEX_HOME: join(dir, 'codex'), CREW_RUN: 'must-be-scrubbed', ANTHROPIC_API_KEY: 'fixture-only',
      ADVISOR_STATE_DIR: overrides.stateDir ?? join(dir, 'advisor'), CLAUDE_SESSION_ID: 'foreign-claude',
      CLAUDE_CODE_SESSION_ID: 'foreign-claude', CREW_MAILBOX: 'claude-foreign', CODEX_THREAD_ID: 'foreign-codex', CREW_OPENCODE_SESSION: 'foreign-opencode' },
    instructions: 'Fixture parent CoS/advisor contract', executable: overrides.executable ?? executable,
    callbacks: {
      identity(value) { identities.push(value); },
      state(state, error) { states.push({ state, error }); },
      event(event) { events.push(event); currentEvents.set(event.key ?? String(events.length), event); },
      request(value) { requests.set(value.id, value); },
      cancelRequest(id) { cancelled.push(id); requests.delete(id); },
      command(id, state, error) { commands.push({ id, state, error }); },
    }, ...(overrides.identity ? { identity: overrides.identity } : {}), ...(overrides.args ? { args: overrides.args } : {}),
  };
  const host = createClaudeHost(options);
  t.after(async () => {
    await host.close();
    for (const identity of identities) if (identity.provider) assert.equal(processExists(identity.provider.pid), false);
    rmSync(dir, { recursive: true, force: true });
  });
  const input = (): Json[] => readFileSync(join(dir, 'input.ndjson'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const users = () => input().filter(value => value.type === 'user');
  const emit = (value: Json) => appendFileSync(join(dir, 'output.ndjson'), JSON.stringify(value) + '\n');
  const launched = () => JSON.parse(readFileSync(join(dir, 'launched.json'), 'utf8')) as Json;
  const approval = (id: string, tool_name = 'Bash', input: Json = { command: 'npm test' }) => emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input } });
  return { dir, host, states, identities, events, currentEvents, requests, cancelled, commands, input, users, emit, launched, approval };
}

it('starts without sending a prompt, persists UUID identity, and resumes exactly across multiple turns', async t => {
  const f = fixture(t, { args: ['--permission-mode', 'auto'] });
  await f.host.start();
  const id = f.identities[0]!.sessionId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(f.users().length, 0);
  assert.equal(f.states.at(-1)?.state, 'idle');
  const launch = f.launched();
  const provider = f.identities.find(identity => identity.provider)?.provider;
  assert.ok(provider); assert.equal(provider.pid, launch.pid); assert.equal(provider.group, true); assert.ok(processMatches(provider));
  assert.equal(launch.sessionId, id); assert.equal(launch.crewRun, null);
  assert.equal(launch.inheritedAuth, 'fixture-only'); assert.equal(launch.stateEvents, '1');
  assert.equal(launch.cwd, realpathSync(f.dir));
  assert.ok(launch.args.includes(`--session-id=${id}`));
  for (const arg of ['--print', '--input-format', '--output-format', '--include-partial-messages', '--verbose', '--append-system-prompt']) assert.ok(launch.args.includes(arg));
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(launch.args[launch.args.indexOf('--append-system-prompt') + 1].startsWith('Fixture parent CoS/advisor contract\n'));
  assert.equal(launch.args[launch.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.ok(launch.args.includes('--replay-user-messages'));
  assert.equal(launch.args[launch.args.indexOf('--system-prompt-snapshot') + 1], 'off');
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'fixture');
  assert.equal(launch.args[launch.args.indexOf('--effort') + 1], 'high');
  assert.equal(await f.host.send('First', 'first'), 'delivered');
  await until(() => f.users().length === 1);
  const user = f.users()[0]!;
  assert.deepEqual(user.message, { role: 'user', content: 'First' });
  assert.equal(user.session_id, id); assert.equal(user.parent_tool_use_id, null);
  assert.equal(user.uuid, f.identities.at(-1)?.turnId);
  f.emit({ fixture: 'result' }); await until(() => f.states.at(-1)?.state === 'idle');
  assert.equal(await f.host.send('Second', 'second'), 'delivered');
  await until(() => f.users().length === 2);
  assert.equal(f.users()[1]?.session_id, id);
  await f.host.close();
  const resumed = fixture(t, { identity: { sessionId: id, turnId: String(user.uuid) } });
  await resumed.host.start();
  assert.ok(resumed.launched().args.includes(`--resume=${id}`));
  assert.ok(!resumed.launched().args.some((arg: string) => /^(?:--continue|--last|--session-id|--fork-session)(?:=|$)/.test(arg)));
  assert.equal(resumed.users().length, 0);
  assert.equal(await resumed.host.send('New input only', 'third'), 'delivered');
  await until(() => resumed.users().length === 1);
  assert.equal(resumed.users()[0]?.session_id, id);
});

it('keeps native turn errors visible after idle and rejects undelivered queued input', async t => {
  const f=fixture(t);
  await f.host.start();
  const session=f.identities[0]!.sessionId;
  assert.equal(await f.host.send('Fail this synthetic turn','failed-turn'),'delivered');
  assert.equal(await f.host.send('Queued input','queued-after-failure'),'queued');
  f.emit({type:'result',session_id:session,is_error:true,subtype:'error_during_execution',result:'Synthetic authentication failure'});
  f.emit({type:'system',session_id:session,subtype:'session_state_changed',state:'idle'});
  await until(()=>f.states.at(-1)?.state==='failed');
  assert.ok(f.events.some(e=>e.kind==='status' && e.text==='Synthetic authentication failure'));
  assert.deepEqual(f.states.at(-1),{state:'failed',error:'Synthetic authentication failure'});
  assert.equal(f.commands.findLast(c=>c.id==='failed-turn')?.state,'delivered','Input acknowledgment does not claim successful turn execution');
  assert.equal(f.commands.findLast(c=>c.id==='queued-after-failure')?.state,'failed');
  assert.equal(f.users().length,1,'Turn failure must not dispatch the queued input');
  assert.equal(await f.host.send('Explicit continuation','continuation'),'delivered');
  assert.equal(f.states.at(-1)?.state,'running');
  f.emit({fixture:'result'});
  await until(()=>f.states.at(-1)?.state==='idle');
  assert.equal(f.states.at(-1)?.error,undefined);
});

it('binds checkpoint and Crew caller ownership to the exact native UUID without hooks or skill expansion, including resume', async t => {
  const f = fixture(t, { mode: 'workflow' }); await f.host.start();
  const id = f.identities[0]!.sessionId;
  const workflow = JSON.parse(readFileSync(join(f.dir, 'workflow.json'), 'utf8'));
  assert.deepEqual(workflow.identity, { host: 'claude-code', sessionId: id });
  assert.equal(workflow.caller.mailbox, `claude-${id}`); assert.equal(workflow.caller.host, 'claude');
  assert.ok(existsSync(workflow.paths.session));
  writeFileSync(workflow.paths.workstream, '# Retained checkpoint\n');
  const launch = f.launched();
  assert.equal(launch.claudeSession, id); assert.equal(launch.claudeCodeSession, id);
  assert.equal(launch.crewMailbox, `claude-${id}`); assert.equal(launch.codexThread, null); assert.equal(launch.opencodeSession, null);
  const instructions = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.ok(instructions.includes(`Your exact native Claude session identity is ${id}.`));
  assert.ok(instructions.includes('invoke the node helper using that inherited environment'));
  await f.host.close();
  const resumed = fixture(t, { mode: 'workflow', identity: { sessionId: id }, stateDir: join(f.dir, 'advisor') });
  await resumed.host.start();
  const recovered = JSON.parse(readFileSync(join(resumed.dir, 'workflow.json'), 'utf8'));
  assert.deepEqual(recovered.identity, workflow.identity); assert.deepEqual(recovered.paths, workflow.paths);
  assert.equal(readFileSync(recovered.paths.workstream, 'utf8'), '# Retained checkpoint\n');
  assert.equal(recovered.caller.mailbox, `claude-${id}`);
  assert.equal(resumed.launched().claudeSession, id);
  assert.ok(resumed.launched().args.includes(`--resume=${id}`));
});

it('queues active input until result AND host idle, and delivers one turn at a time', async t => {
  const f = fixture(t); await f.host.start();
  await f.host.send('A', 'a');
  await until(() => f.users().length === 1);
  assert.equal(await f.host.send('B', 'b'), 'queued');
  assert.equal(await f.host.send('C', 'c'), 'queued');
  await delay(30); assert.equal(f.users().length, 1);
  f.emit({ type: 'result', subtype: 'success' }); await delay(30);
  assert.equal(f.users().length, 1, 'a result while the host remains running must not flush input');
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until(() => f.users().length === 2);
  await until(() => f.commands.some(c => c.id === 'b' && c.state === 'delivered'));
  assert.equal(f.users()[1]?.message.content, 'B');
  assert.deepEqual(f.commands.filter(c => c.id === 'b').map(c => c.state), ['queued', 'delivered']);
  f.emit({ fixture: 'result' }); await until(() => f.users().length === 3);
  assert.equal(f.users()[2]?.message.content, 'C');
});

it('interrupt-and-send waits for idle after ACK, cancels prompts and queued turns, and delivers only replacement', async t => {
  const f = fixture(t, { mode: 'interrupt-delay' }); await f.host.start();
  await f.host.send('Active', 'active'); await until(() => f.users().length === 1);
  await f.host.send('Queued', 'queued');
  f.approval('permission'); await until(() => f.requests.size === 1);
  const stale = [...f.requests.keys()][0]!;
  const replacement = f.host.send('Replacement', 'replacement', true);
  await until(() => f.input().some(v => v.type === 'control_request' && v.request.subtype === 'interrupt'));
  await delay(30); assert.equal(f.users().length, 1);
  assert.equal(f.requests.size, 0); assert.ok(f.cancelled.includes(stale));
  await assert.rejects(f.host.answer({ requestId: 'stale', pendingRequestId: stale, option: 'allow' }), /stale/);
  f.emit({ fixture: 'result' }); assert.equal(await replacement, 'delivered');
  await until(() => f.users().length === 2); assert.equal(f.users()[1]?.message.content, 'Replacement');
  f.emit({ fixture: 'result' }); await until(() => f.states.at(-1)?.state === 'idle');
  await delay(30); assert.equal(f.users().length, 2);
  assert.ok(f.commands.some(c => c.id === 'queued' && c.state === 'failed' && /Cancelled/.test(c.error ?? '')));
});

it('standalone interrupt cancels queued input and remains interrupted until new human input', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('Active', 'active');
  await until(() => f.users().length === 1);
  assert.equal(await f.host.send('Cancelled', 'cancelled'), 'queued');
  await f.host.interrupt();
  await delay(30); assert.equal(f.users().length, 1);
  assert.equal(f.states.at(-1)?.state, 'interrupted');
  assert.deepEqual(f.commands.filter(c => c.id === 'cancelled').map(c => c.state), ['queued', 'failed']);
  assert.equal(await f.host.send('Human continues', 'continue'), 'delivered');
  await until(() => f.users().length === 2);
  assert.equal(f.users()[1]?.message.content, 'Human continues');
});

it('rejects unsupported or malformed control requests and cancelled ids never reappear', async t => {
  const f = fixture(t); await f.host.start();
  f.emit({ type: 'control_request', request_id: 'unsupported', request: { subtype: 'not_supported' } });
  f.emit({ type: 'control_request', request_id: 'bad', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: 'not an object' } });
  f.approval('bad-questions', 'AskUserQuestion', { questions: [{ question: 'Repeated?' }, { question: 'Repeated?' }] });
  await until(() => f.input().filter(v => v.type === 'control_response').length === 3);
  assert.ok(f.input().filter(v => v.type === 'control_response').every(v => v.response.subtype === 'error'));
  assert.equal(f.requests.size, 0);
  f.approval('cancel'); await until(() => f.requests.size === 1);
  assert.equal(await f.host.send('Held during approval', 'held'), 'queued');
  assert.equal(f.users().length, 0);
  f.emit({ type: 'control_cancel_request', request_id: 'cancel' }); await until(() => f.requests.size === 0);
  f.approval('cancel'); await delay(30);
  assert.equal(f.requests.size, 0, 'a duplicate wire request cannot revive a cancelled approval');
  f.emit({ type: 'control_cancel_request', request_id: 'early-cancel' });
  f.approval('early-cancel'); await delay(30);
  assert.equal(f.requests.size, 0, 'a cancellation tombstone also rejects a delayed request');
  // A new send makes the held idle input eligible; FIFO is preserved.
  assert.equal(await f.host.send('Next', 'next'), 'queued');
  await until(() => f.users().length === 1);
  assert.equal(f.users()[0]?.message.content, 'Held during approval');
});

it('maps one-time approvals and structured questions to valid control responses and rejects stale replies', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('Permissions', 'prompt');
  f.approval('allow'); await until(() => f.requests.size === 1);
  const allow = [...f.requests.values()][0]!;
  assert.equal(allow.kind, 'approval');
  await assert.rejects(f.host.answer({ requestId: 'invalid', pendingRequestId: allow.id, option: 'always' }), /Invalid/);
  assert.equal(f.requests.size, 1);
  await f.host.answer({ requestId: 'allow-answer', pendingRequestId: allow.id, option: 'allow' });
  await until(() => f.input().some(v => v.response?.request_id === 'allow'));
  assert.deepEqual(f.input().find(v => v.response?.request_id === 'allow')?.response,
    { subtype: 'success', request_id: 'allow', response: { behavior: 'allow', updatedInput: { command: 'npm test' } } });
  await assert.rejects(f.host.answer({ requestId: 'duplicate', pendingRequestId: allow.id, option: 'allow' }), /stale/);
  f.approval('deny'); await until(() => f.requests.size === 1);
  await f.host.answer({ requestId: 'deny-answer', pendingRequestId: [...f.requests.keys()][0]!, option: 'deny' });
  await until(() => f.input().some(v => v.response?.request_id === 'deny'));
  assert.equal(f.input().find(v => v.response?.request_id === 'deny')?.response.response.behavior, 'deny');
  const questions = [{ question: 'Format?', header: 'Format', options: [{ label: 'Brief', description: 'Short' }], multiSelect: false },
    { question: 'Sections?', header: 'Sections', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
    { question: '__proto__', header: 'Key', options: [{ label: 'Own field' }], multiSelect: false }];
  f.approval('question', 'AskUserQuestion', { questions }); await until(() => f.requests.size === 1);
  const q = [...f.requests.values()][0]!;
  assert.equal(q.kind, 'question');
  if (q.kind !== 'question') assert.fail();
  assert.deepEqual(q.questions.map(q => q.id), ['0', '1', '2']);
  await assert.rejects(f.host.answer({ requestId: 'incomplete', pendingRequestId: q.id, answers: { '0': 'Brief' } }), /requires/);
  await f.host.answer({ requestId: 'question-answer', pendingRequestId: q.id, answers: { '0': 'My free text', '1': ['A', 'B'], '2': 'Own field' } });
  await until(() => f.input().some(v => v.response?.request_id === 'question'));
  assert.deepEqual(f.input().find(v => v.response?.request_id === 'question')?.response.response,
    { behavior: 'allow', updatedInput: { questions, answers: { 'Format?': 'My free text', 'Sections?': ['A', 'B'], ['__proto__']: 'Own field' } } });
  f.approval('cancel'); await until(() => f.requests.size === 1);
  const cancel = [...f.requests.keys()][0]!;
  f.emit({ type: 'control_cancel_request', request_id: 'cancel' }); await until(() => f.requests.size === 0);
  await assert.rejects(f.host.answer({ requestId: 'cancel-answer', pendingRequestId: cancel, option: 'allow' }), /stale/);
  assert.ok(!f.input().some(v => v.response?.request_id === 'cancel'));
});

it('upserts public deltas, final text and tool output without thinking or duplicate messages', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('Stream', 'stream');
  const stream = (event: Json) => f.emit({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'msg-1' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private thought' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private delta' } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } });
  stream({ type: 'content_block_stop', index: 1 });
  f.emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello world' }] } });
  stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } });
  stream({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
  stream({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"npm test"}' } });
  stream({ type: 'message_stop' });
  f.emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'thinking', thinking: 'private final' },
    { type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] } });
  f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'Passed' }, { type: 'thinking', thinking: 'private tool' }] }] } });
  f.emit({ fixture: 'result' }); await until(() => f.states.at(-1)?.state === 'idle');
  const publicEvents = [...f.currentEvents.values()];
  assert.deepEqual(publicEvents.filter(e => e.kind === 'assistant'), [{ kind: 'assistant', key: 'claude:msg-1:1', text: 'Hello world', streaming: false }]);
  assert.deepEqual(publicEvents.filter(e => e.kind === 'tool'), [{ kind: 'tool', key: 'claude:tool:tool-1', title: 'Bash', text: 'Passed', state: 'completed' }]);
  assert.ok(f.events.some(e => e.kind === 'assistant' && e.streaming && e.text === 'Hello '));
  assert.ok(f.events.some(e => e.kind === 'tool' && e.text === '{"command":"npm test"}'));
  assert.doesNotMatch(JSON.stringify(f.events), /private|thinking/);
});

it('keeps host default permissions, explicitly overrides full, and fails workspace or non-exact identities before spawn', async t => {
  const normal = fixture(t); await normal.host.start();
  assert.ok(!normal.launched().args.includes('--permission-mode'));
  const full = fixture(t, { access: 'full', args: ['--permission-mode=plan', '--restricted', '--allowedTools', 'Read'] });
  await full.host.start();
  const args = full.launched().args as string[];
  assert.ok(args.includes('--dangerously-skip-permissions')); assert.ok(!args.includes('--restricted'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(args.includes('--allowedTools'));
  const workspace = fixture(t, { access: 'workspace', args: ['--dangerously-skip-permissions'] });
  await assert.rejects(workspace.host.start(), /workspace confinement is unsupported/);
  assert.ok(!existsSync(join(workspace.dir, 'launched.json')));
  assert.equal(workspace.commands.at(-1)?.state, 'failed');
  const invalid = fixture(t, { identity: { sessionId: '--continue' } });
  await assert.rejects(invalid.host.start(), /exact recorded UUID/);
  assert.ok(!existsSync(join(invalid.dir, 'launched.json')));
  const conflict = fixture(t, { args: ['--resume=anything'] });
  await assert.rejects(conflict.host.start(), /conflicts/);
  const privateArg = fixture(t, { args: ['--append-system-prompt=synthetic-private-value'] });
  await assert.rejects(privateArg.host.start(), /conflicts.*--append-system-prompt/);
  assert.doesNotMatch(JSON.stringify(privateArg.states) + JSON.stringify(privateArg.commands), /synthetic-private-value/);
});

it('reports initialization rejection, process loss, malformed output and session mismatches explicitly', async t => {
  for (const mode of ['initialize-error', 'initialize-disconnect']) {
    const f = fixture(t, { mode }); await assert.rejects(f.host.start());
    assert.ok(f.commands.some(c => c.id === 'launch' && c.state === 'uncertain'));
  }
  const missing = fixture(t, { executable: '/nonexistent/crew-fixture-claude' });
  await assert.rejects(missing.host.start()); assert.ok(missing.states.some(s => s.state === 'failed'));
  const f = fixture(t); await f.host.start(); await f.host.send('Active', 'active'); await f.host.send('Queued', 'queued');
  f.approval('pending'); await until(() => f.requests.size === 1);
  const stale = [...f.requests.keys()][0]!;
  f.emit({ fixture: 'exit', code: 7 });
  await until(() => f.states.some(s => s.state === 'failed' || s.state === 'disconnected'));
  assert.equal(f.requests.size, 0);
  assert.deepEqual(f.commands.filter(c => c.id === 'active').map(c => c.state), ['queued', 'delivered']);
  assert.ok(f.commands.some(c => c.id === 'queued' && c.state === 'failed'));
  await assert.rejects(f.host.answer({ requestId: 'stale', pendingRequestId: stale, option: 'allow' }));
  for (const row of [{ fixture: 'raw', text: '{"thinking":"private malformed thought",bad JSON}\n' }, { type: 'system', subtype: 'init', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]) {
    const broken = fixture(t); await broken.host.start(); broken.emit(row);
    await until(() => broken.states.some(s => s.state === 'failed'));
    assert.doesNotMatch(JSON.stringify(broken.states), /private malformed thought/);
    await assert.rejects(broken.host.send('Never', 'never'));
  }
  const eof = fixture(t); await eof.host.start(); eof.emit({ fixture: 'end' });
  await until(() => eof.states.some(s => s.state === 'disconnected'));
  await assert.rejects(eof.host.send('Never', 'eof'));
  assert.equal(eof.commands.at(-1)?.state, 'failed', 'input never written after disconnect is known failed');
});

it('interrupt failure cannot release replacement input and close invalidates all pending commands', async t => {
  const f = fixture(t, { mode: 'interrupt-error' }); await f.host.start(); await f.host.send('Active', 'active');
  await assert.rejects(f.host.send('Never deliver', 'replacement', true), /rejected/);
  assert.ok(!f.users().some(v => v.message.content === 'Never deliver'));
  assert.ok(f.commands.some(c => c.id === 'replacement' && c.state === 'uncertain'));
  const closing = fixture(t); await closing.host.start(); await closing.host.send('Active', 'active');
  await closing.host.send('Queued', 'queued');
  closing.approval('pending'); await until(() => closing.requests.size === 1);
  await closing.host.close(); await closing.host.close();
  assert.equal(closing.states.at(-1)?.state, 'closed'); assert.equal(closing.requests.size, 0);
  assert.deepEqual(closing.commands.filter(c => c.id === 'active').map(c => c.state), ['queued', 'delivered']);
  assert.ok(closing.commands.some(c => c.id === 'queued' && c.state === 'failed'));
  await assert.rejects(closing.host.send('Closed', 'closed'), /not connected/);
});

it('requires a native echo with current UUID and session, ignores tool rows and reused echoes, and reports missing-ACK disconnect uncertain', async t => {
  const f = fixture(t, { mode: 'no-user-ack' }); await f.host.start();
  const first = f.host.send('First', 'first');
  await until(() => f.users().length === 1);
  const user = f.users()[0]!;
  assert.equal(f.commands.at(-1)?.state, 'queued', 'successful pipe write alone cannot confirm input delivery');
  f.emit({ ...user, uuid: 'reused-old-id' });
  f.emit({ ...user, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Result' }] } });
  await delay(30);
  assert.ok(!f.commands.some(c => c.id === 'first' && c.state === 'delivered'));
  f.emit(user); assert.equal(await first, 'delivered');
  f.emit({ fixture: 'result' }); await until(() => f.states.at(-1)?.state === 'idle');
  const second = f.host.send('Second', 'second'); await until(() => f.users().length === 2);
  assert.notEqual(f.users()[1]?.uuid, user.uuid);
  f.emit(user); await delay(30);
  assert.ok(!f.commands.some(c => c.id === 'second' && c.state === 'delivered'));
  f.emit({ fixture: 'exit', code: 9 }); assert.equal(await second, 'uncertain');
  assert.deepEqual(f.commands.filter(c => c.id === 'first').map(c => c.state), ['queued', 'delivered']);
  assert.deepEqual(f.commands.filter(c => c.id === 'second').map(c => c.state), ['queued', 'uncertain']);
  const wrong = fixture(t, { mode: 'no-user-ack' }); await wrong.host.start();
  const input = wrong.host.send('Mismatch', 'wrong'); await until(() => wrong.users().length === 1);
  wrong.emit({ ...wrong.users()[0]!, session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(await input, 'uncertain');
  assert.ok(!wrong.commands.some(c => c.state === 'delivered'));
});

it('times out a missing native echo as uncertain and never resends the input', async t => {
  const f = fixture(t, { mode: 'no-user-ack' }); await f.host.start();
  assert.equal(await f.host.send('No echo', 'missing-ack'), 'uncertain');
  assert.deepEqual(f.commands.filter(c => c.id === 'missing-ack').map(c => c.state), ['queued', 'uncertain']);
  assert.ok(f.states.some(s => /acknowledgment timed out/.test(s.error ?? '')));
  assert.equal(f.users().length, 1);
});

it('interrupts input still awaiting its echo without orphaning the receipt or replaying it', async t => {
  const f = fixture(t, { mode: 'no-user-ack' }); await f.host.start();
  const first = f.host.send('Blocked acknowledgment', 'blocked');
  await until(() => f.users().length === 1);
  await f.host.interrupt();
  assert.equal(await first, 'uncertain');
  assert.equal(f.states.at(-1)?.state, 'interrupted');
  f.emit(f.users()[0]!); await delay(30);
  assert.deepEqual(f.commands.filter(c => c.id === 'blocked').map(c => c.state), ['queued', 'uncertain']);
  const next = f.host.send('Human continues', 'next'); await until(() => f.users().length === 2);
  f.emit(f.users()[1]!); assert.equal(await next, 'delivered');
  assert.equal(f.users().length, 2);
});

it('bounds public text and JSON deltas, queued human input, and incomplete wire frames', async t => {
  const f = fixture(t); await f.host.start(); await f.host.send('Bounded', 'active');
  for (let i = 0; i < 16; i++) assert.equal(await f.host.send(`Queued ${i}`, `q${i}`), 'queued');
  await assert.rejects(f.host.send('Overflow', 'overflow'), /queue is full/);
  await assert.rejects(f.host.send('x'.repeat(24_001), 'too-long'), /24,000/);
  const stream = (event: Json) => f.emit({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'large' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a'.repeat(15_000) } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a'.repeat(15_000) } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'large-tool', name: 'Bash', input: {} } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'b'.repeat(80_000) } });
  f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'large-tool', content: 'c'.repeat(80_000) }] } });
  await until(() => f.events.some(e => e.kind === 'tool' && e.state === 'completed'));
  assert.ok(f.events.filter(e => e.kind === 'assistant' || e.kind === 'tool').every(e => e.text.length <= 24_000));
  assert.ok(f.events.some(e => e.kind === 'assistant' && e.text.endsWith('[Output truncated]')));
  assert.ok(f.events.some(e => e.kind === 'tool' && e.text.endsWith('[Output truncated]')));
  assert.equal(f.users().length, 1);
  f.emit({ fixture: 'raw', text: '{"content":"' + 'x'.repeat(1024 * 1024) });
  await until(() => f.states.some(s => /stream frame exceeded/.test(s.error ?? '')));
});
