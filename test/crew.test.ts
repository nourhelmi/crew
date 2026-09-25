import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'crew-test-'));
process.env.CREW_HOME = HOME;
process.env.CREW_CONFIG = join(HOME, 'no-config.json');

const { parseModel, route, clampEffort } = await import('../src/route.ts');
const { parseResult } = await import('../src/result.ts');
const store = await import('../src/store.ts');
const mail = await import('../src/mail.ts');
const { runHook } = await import('../src/hook.ts');
const { argv, bootstrap } = await import('../src/spawn.ts');
type RunMeta = import('../src/types.ts').RunMeta;

after(() => rmSync(HOME, { recursive: true, force: true }));
beforeEach(() => { rmSync(join(HOME, 'runs'), { recursive: true, force: true }); rmSync(join(HOME, 'mail'), { recursive: true, force: true }); });

const ROOT = { mailbox: 'claude-root', host: 'claude' as const, name: 'root' };

function run(overrides: Partial<RunMeta> = {}): RunMeta {
  const meta: RunMeta = {
    id: 'b-test', name: 'builder-x', role: 'builder',
    route: { host: 'codex', model: 'gpt-6-sol', effort: 'high', strategy: 'pinned' },
    cwd: '/tmp', keep: false, parent: ROOT, launcher: 'exec', createdAt: new Date().toISOString(), state: 'running',
    ...overrides,
  };
  store.writeRun(meta);
  return meta;
}

const writeResult = (id: string, status: string): void =>
  writeFileSync(store.resultPath(id), `# Status\n${status}\n\n# Claims\n- ok\n`);

describe('parseModel', () => {
  it('derives the CLI from the provider prefix', () => {
    assert.deepEqual(parseModel('claude-bridge/claude-opus-5-5@high'), { host: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    assert.deepEqual(parseModel('openai-codex/gpt-6-sol'), { host: 'codex', model: 'gpt-6-sol' });
  });
  it('recognises bare native model ids and aliases', () => {
    assert.equal(parseModel('gpt-6-luna@low').host, 'codex');
    assert.equal(parseModel('opus').host, 'claude');
    assert.equal(parseModel('claude-sonnet-5').host, 'claude');
  });
  it('clamps efforts a CLI does not support', () => {
    assert.equal(parseModel('openai-codex/gpt-6-sol@max').effort, 'xhigh');
    assert.equal(clampEffort('claude', 'minimal'), 'low');
    assert.equal(parseModel('gpt-6-sol@off').effort, 'minimal');
  });
  it('rejects models without a native CLI', () => {
    assert.throws(() => parseModel('cursor/grok-4.6@high'), /no native CLI/);
    assert.throws(() => parseModel('grok-4.6'), /cannot tell/);
    assert.throws(() => parseModel('gpt-6-sol@ultra'), /unknown effort/);
  });
});

describe('route', () => {
  const config = store.loadConfig();
  it('uses a pinned model without asking the router', async () => {
    const chosen = await route({ role: 'builder', task: 't', model: 'opus@medium' }, config, async () => assert.fail('router called'));
    assert.deepEqual(chosen, { host: 'claude', model: 'opus', effort: 'medium', strategy: 'pinned' });
  });
  it('takes the Jev decision', async () => {
    const chosen = await route({ role: 'checker', task: 't' }, config,
      async request => { assert.equal(request.harness, 'native'); return { selected: { model: 'openai-codex/gpt-6-sol', thinking: 'xhigh' }, strategy: 'jev' }; });
    assert.equal(chosen.host, 'codex');
    assert.equal(chosen.effort, 'xhigh');
    assert.equal(chosen.strategy, 'jev');
  });
  it('falls back to the role default when the router fails', async () => {
    const chosen = await route({ role: 'advisor', task: 't' }, config, async () => { throw new Error('offline'); });
    assert.equal(chosen.strategy, 'default');
    assert.equal(chosen.model, 'claude-opus-5-5');
    assert.match(chosen.reason ?? '', /offline/);
  });
});

describe('parseResult', () => {
  it('reads the first line under a Status heading', () => {
    assert.deepEqual(parseResult('## Status\n\nDONE - shipped\n## Claims'), { verdict: 'done', line: 'DONE - shipped' });
    assert.equal(parseResult('# Status\n**BLOCKED: need the API key decision**')?.verdict, 'blocked');
    assert.equal(parseResult('Status: FAILED tests red')?.verdict, 'failed');
    assert.equal(parseResult('# Status\nPASS')?.verdict, 'done');
  });
  it('treats missing or in-progress status as not terminal', () => {
    assert.equal(parseResult('# Claims\nDONE'), undefined);
    assert.equal(parseResult('# Status\nIN PROGRESS'), undefined);
    assert.equal(parseResult('# Status\n\n# Claims'), undefined);
  });
});

describe('mailbox', () => {
  it('reads only complete lines past the cursor', () => {
    store.appendMail('mb', { id: '1', at: '', kind: 'message', from: { mailbox: 'x' }, text: 'one' });
    const first = store.unread('mb');
    assert.equal(first.mails.length, 1);
    first.commit();
    assert.equal(store.unread('mb').mails.length, 0);
    writeFileSync(join(store.mailDir('mb'), 'inbox.jsonl'), '{"id":"partial"', { flag: 'a' });
    assert.equal(store.unread('mb').mails.length, 0);
  });
  it('skips mail a push already showed in full', () => {
    store.appendMail('mb2', { id: '1', at: '', kind: 'message', from: { mailbox: 'x' }, text: 'a', pushed: true });
    store.appendMail('mb2', { id: '2', at: '', kind: 'message', from: { mailbox: 'x' }, text: 'b' });
    assert.deepEqual(mail.takeUnread('mb2').map(m => m.id), ['2']);
  });
  it('prefers an armed waiter and otherwise queues', () => {
    const release = store.markWaiter('claude-root');
    assert.equal(mail.send({ mailbox: 'b-test', host: 'codex' }, ROOT, 'hi'), 'waiter');
    release();
    assert.equal(mail.send({ mailbox: 'b-test', host: 'codex' }, ROOT, 'again'), 'queued');
    assert.deepEqual(mail.takeUnread('claude-root').map(m => m.text), ['hi', 'again']);
  });
  it('resolves parent, names and raw mailboxes', () => {
    run();
    assert.deepEqual(mail.resolve('parent', { mailbox: 'b-test', host: 'codex' }), ROOT);
    assert.equal(mail.resolve('builder-x', ROOT).mailbox, 'b-test');
    assert.equal(mail.resolve('codex-019abc', ROOT).threadId, '019abc');
    assert.throws(() => mail.resolve('parent', ROOT), /no crew parent/);
    assert.throws(() => mail.resolve('nobody', ROOT), /no run/);
  });
});

describe('settlement', () => {
  it('notifies the parent once per result', () => {
    run();
    writeResult('b-test', 'DONE: all green');
    assert.equal(mail.settle('b-test'), 'queued');
    assert.equal(mail.settle('b-test'), undefined);
    const [notice] = mail.takeUnread('claude-root');
    assert.equal(notice?.kind, 'settled');
    assert.match(notice?.text ?? '', /DONE: all green/);
    assert.equal(store.readRun('b-test')?.state, 'done');
  });
  it('keeps a kept teammate running and re-notifies on a new result', () => {
    run({ keep: true });
    writeResult('b-test', 'DONE: first');
    mail.settle('b-test');
    writeResult('b-test', 'BLOCKED: second needs a call');
    mail.settle('b-test');
    assert.equal(store.readRun('b-test')?.state, 'running');
    assert.equal(mail.takeUnread('claude-root').length, 2);
  });
  it('reports a dialog-blocked child once per episode', () => {
    run({ launcher: 'herdr', herdr: { pane: 'w1:p2', agent: 'builder-x' } });
    assert.equal(mail.waiting('b-test', true), 'queued');
    assert.equal(mail.waiting('b-test', true), undefined);
    assert.equal(mail.waiting('b-test', false), undefined);
    assert.equal(mail.waiting('b-test', true), 'queued');
    assert.deepEqual(mail.takeUnread('claude-root').map(m => m.kind), ['waiting', 'waiting']);
  });
  it('reports a stall only once', () => {
    run();
    assert.equal(mail.stall('b-test', 'codex exec exited'), 'queued');
    assert.equal(mail.stall('b-test', 'again'), undefined);
    assert.match(mail.takeUnread('claude-root')[0]?.text ?? '', /no terminal result/);
  });
});

describe('hooks', () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CREW_HOME: HOME, ...extra });
  const stop = (active: boolean, extra: Record<string, string>) =>
    runHook('stop', 'codex', JSON.stringify({ session_id: 'thread-1', stop_hook_active: active }), env(extra));

  it('blocks a run once without a result, then reports it stalled', () => {
    run();
    assert.match(stop(false, { CREW_RUN: 'b-test' }), /"decision":"block".*terminal result/);
    assert.equal(stop(true, { CREW_RUN: 'b-test' }), '');
    assert.equal(store.readRun('b-test')?.state, 'stalled');
    assert.equal(mail.takeUnread('claude-root')[0]?.kind, 'stalled');
  });
  it('settles a run that wrote its result, even after a stall', () => {
    run({ state: 'stalled' });
    writeResult('b-test', 'PASS');
    assert.equal(stop(false, { CREW_RUN: 'b-test' }), '');
    assert.equal(store.readRun('b-test')?.state, 'done');
    assert.equal(mail.takeUnread('claude-root')[0]?.kind, 'settled');
  });
  it('keeps any session going until it has seen its mail', () => {
    mail.send(ROOT, { mailbox: 'codex-thread-1', host: 'codex' }, 'check the migration order');
    const out = stop(false, {});
    assert.match(out, /check the migration order/);
    assert.equal(stop(false, {}), '');
  });
  it('records the session and exports a Claude mailbox', () => {
    run();
    const envFile = join(HOME, 'claude.env');
    writeFileSync(envFile, '');
    runHook('session-start', 'claude', '{"session_id":"s-1"}', env({ CREW_RUN: 'b-test', CLAUDE_ENV_FILE: envFile }));
    assert.equal(store.readRun('b-test')?.sessionId, 's-1');
    assert.match(readFileSync(envFile, 'utf8'), /CREW_MAILBOX=claude-s-1/);
    runHook('session-start', 'codex', '{"session_id":"t-9"}', env({ CREW_RUN: 'b-test' }));
    assert.equal(store.readRun('b-test')?.threadId, 't-9');
  });
  it('never throws into the host', () => {
    assert.equal(runHook('stop', 'claude', '{not json', env()), '');
  });
});

describe('launch shape', () => {
  it('builds native argv per host with the bootstrap last', () => {
    const config = store.loadConfig();
    const claude = argv('claude', { host: 'claude', model: 'claude-opus-5-5', effort: 'high', strategy: 'jev' }, 'adv', config, 'GO');
    assert.deepEqual(claude, ['--model', 'claude-opus-5-5', '--effort', 'high', '--name', 'adv', '--permission-mode', 'auto', 'GO']);
    const codex = argv('codex', { host: 'codex', model: 'gpt-6-sol', effort: 'xhigh', strategy: 'jev' }, 'b', config, 'GO');
    assert.deepEqual(codex, ['--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="xhigh"', 'GO']);
  });
  it('points the child at its role skill, packet and result', () => {
    const text = bootstrap({ id: 'c-1', name: 'checker-1', role: 'checker', keep: false, parent: ROOT });
    assert.match(text, /skills\/advisor-role-checker\/SKILL\.md/);
    assert.match(text, /runs\/c-1\/packet\.md/);
    assert.match(text, /runs\/c-1\/result\.md/);
    assert.match(text, /crew msg parent/);
  });
});
