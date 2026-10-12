import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { AcpServer } from '../adapters/acp/index.ts';
import { AcpWire } from '../adapters/acp/wire.ts';
import { ConsoleController, hostCapabilities } from '../src/console-controller.ts';
import { childTargetId } from '../src/console-children.ts';
import { processExists } from '../src/console-process.ts';
import { readMeta, sessionDir } from '../src/console-store.ts';
import { listRuns, markWaiter, readRun, writeJson } from '../src/store.ts';
import { stopRun } from '../src/retire.ts';
import type { RunMeta } from '../src/types.ts';

type Json = Record<string, any>;
async function until<T>(read: () => T | false | undefined, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > deadline) throw new Error('ACP engine fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('ACP drives actual Crew supervisors and both native provider transports with isolated fake peers', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-acp-engine-'));
  const previous = { ...process.env };
  const clients: AcpServer[] = [];
  const supervisors: ReturnType<typeof spawn>[] = [];
  const roots: string[] = [];
  let unmark: (() => void) | undefined;
  for (const key of ['CREW_RUN', 'CREW_MAILBOX', 'CREW_ROUTER', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SESSION', 'CREW_CONSOLE_SESSION', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']) delete process.env[key];
  Object.assign(process.env, { HOME: root, CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json'), CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home'), ADVISOR_STATE_DIR: join(root, 'advisor') });
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], claude: ['--permission-mode', 'default'] } });
  writeJson(process.env.CREW_ROSTER!, { models: ['codex', 'claude'].map(host => ({ model: `${host}/fixture`, effort: 'high', roles: ['builder', 'advisor'], cost: 0, use: 'isolated fixture' })) });
  mkdirSync(join(root, 'bin'));
  for (const host of ['codex', 'claude']) {
    // These executables import only the fake peers: no native CLI/auth or model request can run.
    writeFileSync(join(root, 'bin', host), `#!${process.execPath}\nimport {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const key=process.env.CREW_RUN||process.env.CREW_CONSOLE_SESSION;const dir=join(process.env.CREW_HOME,'providers',key);mkdirSync(dir,{recursive:true});
if(${JSON.stringify(host)}==='codex'){process.env.FAKE_CODEX_LOG=join(dir,'wire.jsonl');process.env.FAKE_CODEX_SCENARIO=join(dir,'scenario.json');if(!existsSync(process.env.FAKE_CODEX_SCENARIO))writeFileSync(process.env.FAKE_CODEX_SCENARIO,JSON.stringify({threadId:'native-'+key,...(process.env.CREW_RUN?{initialChildRequest:'approval'}:{})}));}
else{process.env.CLAUDE_FIXTURE_DIR=dir;for(const name of ['input.ndjson','output.ndjson'])if(!existsSync(join(dir,name)))writeFileSync(join(dir,name),'');}
await import(${JSON.stringify(resolve(`test/fixtures/console-${host}.ts`))});\n`, { mode: 0o755 });
  }
  writeFileSync(join(root, 'bin', 'herdr'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${previous.PATH}`;
  const controller = new ConsoleController({ root, receiptWaitMs: 3000,
    providers: () => (['codex', 'claude'] as const).map(id => ({ id, label: id, available: true, models: [{ id: 'fixture', label: 'Fixture', efforts: ['high'] }], capabilities: hostCapabilities(id) })),
    startSupervisor: async id => {
      if (id.startsWith('s-') && !roots.includes(id)) roots.push(id);
      const child = spawn(process.execPath, [resolve('src/console-supervisor.ts'), sessionDir(id, root)], { env: { ...process.env }, stdio: 'ignore' });
      supervisors.push(child); await once(child, 'spawn');
    },
  });
  const connect = () => {
    const output = new PassThrough(); const messages: Json[] = []; let sequence = 0;
    output.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) if (line) messages.push(JSON.parse(line)); });
    const server = new AcpServer(controller, new AcpWire(output), 20); clients.push(server);
    const call = async (method: string, params: object): Promise<Json> => { const id = ++sequence; await server.receive({ jsonrpc: '2.0', id, method, params }); return messages.find(message => message.id === id)!; };
    return { server, messages, call };
  };
  const wires = (key: string, host = 'codex'): Json[] => readFileSync(join(root, 'providers', key, host === 'codex' ? 'wire.jsonl' : 'input.ndjson'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  try {
    const client = connect(); await client.call('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    const sessionId = (await client.call('session/new', { cwd: root, mcpServers: [] })).result.sessionId as string;
    assert.equal(controller.bootstrap().sessions.length, 0);
    const first = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'events' }] });
    assert.ok(first.result, JSON.stringify(first.error));
    assert.equal(first.result.stopReason, 'end_turn');
    const rootId = client.server.store.read(sessionId).consoleId!;
    const nativeId = readMeta(rootId, root)!.identity!.sessionId;
    assert.ok(client.messages.filter(message => message.params?.update?.sessionUpdate === 'agent_message_chunk').map(message => message.params.update.content?.text ?? '').join('').includes('hello'), JSON.stringify(client.messages));
    assert.ok(client.messages.some(message => message.params?.update?.title === 'npm test' && message.params.update.status === 'completed'));
    assert.ok(!JSON.stringify(client.messages).includes('SECRET_REASONING'));
    let completed = false;
    const prompt = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }] }).then(result => { completed = true; return result; });
    await until(() => controller.session(rootId)?.state === 'running');
    unmark = markWaiter(`codex-${nativeId}`);
    const spawnChild = async (host: string): Promise<RunMeta> => {
      const { stdout } = await promisify(execFile)(resolve('bin/crew'), ['spawn', '--role', 'builder', '--task', 'Bounded synthetic ACP integration fixture; no actual work.', '--cwd', root, '--model', `${host}/fixture`, '--effort', 'high', '--keep', '--json'], { env: { ...process.env, CODEX_THREAD_ID: nativeId, CREW_CONSOLE_SESSION: rootId }, timeout: 15_000 });
      const run = JSON.parse(stdout) as RunMeta;
      assert.equal(run.launcher, 'console');
      await until(() => readMeta(childTargetId(run.id), root)?.identity?.provider);
      return readRun(run.id)!;
    };
    const codex = await spawnChild('codex'); const claude = await spawnChild('claude');
    const emit = (message: object): void => { appendFileSync(join(root, 'providers', claude.id, 'output.ndjson'), `${JSON.stringify(message)}\n`); };
    emit({ type: 'assistant', message: { id: 'child-text', content: [{ type: 'text', text: 'Child stream proof' }, { type: 'tool_use', id: 'child-tool', name: 'Bash', input: { command: 'echo fixture' } }] } });
    emit({ type: 'control_request', request_id: 'claude-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo synthetic' } } });
    const codexRequest = await until(() => client.messages.find(message => message.method === 'session/request_permission' && message.params?.toolCall?._meta?.crew?.runId === codex.id));
    const claudeRequest = await until(() => client.messages.find(message => message.method === 'session/request_permission' && message.params?.toolCall?._meta?.crew?.runId === claude.id));
    assert.equal(codexRequest.params.sessionId, sessionId); assert.equal(claudeRequest.params.sessionId, sessionId); assert.equal(completed, false);
    await client.server.receive({ jsonrpc: '2.0', id: codexRequest.id, result: { outcome: { outcome: 'selected', optionId: 'decline' } } });
    await client.server.receive({ jsonrpc: '2.0', id: claudeRequest.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await until(() => wires(codex.id).find(wire => wire.id === 101 && wire.result?.decision === 'decline'));
    await until(() => wires(claude.id, 'claude').find(wire => wire.response?.request_id === 'claude-permission' && wire.response.response?.behavior === 'allow'));
    const childText = await until(() => client.messages.find(message => message.params?.update?.content?.text === 'Child stream proof'));
    assert.equal(childText.params.update._meta.crew.runId, claude.id);
    assert.ok(client.messages.some(message => message.params?.update?._meta?.crew.runId === claude.id && message.params.update.sessionUpdate === 'tool_call'));
    const cancel = await client.call('session/cancel', { sessionId }); assert.ok(cancel.result, JSON.stringify(cancel.error));
    assert.equal((await prompt).result.stopReason, 'cancelled');
    for (const id of [rootId, childTargetId(codex.id), childTargetId(claude.id)]) assert.equal(readMeta(id, root)!.mailPaused, true);
    const ownedIds = [rootId, childTargetId(codex.id), childTargetId(claude.id)];
    const providerPids = ownedIds.map(id => readMeta(id, root)!.identity!.provider!.pid);
    const supervisorPids = ownedIds.map(id => readMeta(id, root)!.pid!);
    await client.server.close();
    for (const pid of providerPids) assert.equal(processExists(pid), false, `Owned provider ${pid} must exit on disconnect`);
    await until(() => supervisorPids.every(pid => !processExists(pid)));
    for (const pid of supervisorPids) assert.equal(processExists(pid), false, `Owned supervisor ${pid} must exit on disconnect`);
    assert.equal(readMeta(rootId, root)!.identity!.sessionId, nativeId);
    assert.equal(readRun(codex.id)!.sessionId, codex.sessionId); assert.notEqual(readRun(codex.id)!.state, 'stopped');
    const reloaded = connect(); await reloaded.call('initialize', { protocolVersion: 1 });
    assert.ok((await reloaded.call('session/load', { sessionId, cwd: root, mcpServers: [] })).result);
    assert.equal((await reloaded.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'events' }] })).result.stopReason, 'end_turn');
    assert.equal(readMeta(rootId, root)!.identity!.sessionId, nativeId);
    assert.ok(wires(rootId).some(wire => wire.method === 'thread/resume' && wire.params.threadId === nativeId));
    assert.equal(controller.bootstrap().sessions.length, 1);
  } finally {
    unmark?.();
    for (const client of clients) await client.close().catch(() => {});
    for (const run of listRuns()) await stopRun(run).catch(() => {});
    for (const id of roots) {
      const session = controller.detail(id)?.session;
      if (session && session.state !== 'closed') await controller.action(id, { requestId: `cleanup-${Date.now()}`, action: 'close', revision: session.revision }).catch(() => {});
    }
    for (const child of supervisors) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    const mail = join(root, 'mail');
    if (existsSync(mail)) for (const mailbox of readdirSync(mail)) {
      try { process.kill(Number(readFileSync(join(mail, mailbox, 'watcher'), 'utf8')), 'SIGTERM'); } catch { /* Owned isolated watcher may already be gone. */ }
    }
    process.env = previous; rmSync(root, { recursive: true, force: true });
  }
});
