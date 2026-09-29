import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'crew-test-'));
process.env.CREW_HOME = HOME;
process.env.CREW_CONFIG = join(HOME, 'no-config.json');
process.env.CREW_ROSTER = join(HOME, 'no-roster.json');

const { parseModel, route, clampEffort } = await import('../src/route.ts');
const { parseResult } = await import('../src/result.ts');
const store = await import('../src/store.ts');
const mail = await import('../src/mail.ts');
const { runHook } = await import('../src/hook.ts');
const { argv, bootstrap, firstPrompt, writableRoots, ROOT: ROOT_DIR } = await import('../src/spawn.ts');
const { startAgent, typedLine, TTY_LINE_MAX } = await import('../src/herdr.ts');
type RunMeta = import('../src/types.ts').RunMeta;

after(() => rmSync(HOME, { recursive: true, force: true }));
beforeEach(() => { rmSync(join(HOME, 'runs'), { recursive: true, force: true }); rmSync(join(HOME, 'mail'), { recursive: true, force: true }); });

const ROOT = { mailbox: 'claude-root', host: 'claude' as const, name: 'root' };

function run(overrides: Partial<RunMeta> = {}): RunMeta {
  const meta: RunMeta = {
    id: 'b-test', name: 'builder-x', role: 'builder',
    route: { host: 'codex', model: 'gpt-6.1-sol', effort: 'high', strategy: 'pinned' },
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
    assert.deepEqual(parseModel('openai-codex/gpt-6.1-sol'), { host: 'codex', model: 'gpt-6.1-sol' });
  });
  it('recognises bare native model ids and aliases', () => {
    assert.equal(parseModel('gpt-6-luna@low').host, 'codex');
    assert.equal(parseModel('opus').host, 'claude');
    assert.equal(parseModel('claude-sonnet-5').host, 'claude');
  });
  it('clamps efforts a CLI does not support', () => {
    assert.equal(parseModel('openai-codex/gpt-6.1-sol@max').effort, 'max');
    assert.equal(clampEffort('claude', 'minimal'), 'low');
    assert.equal(parseModel('gpt-6.1-sol@off').effort, 'minimal');
  });
  it('rejects models without a native CLI', () => {
    assert.throws(() => parseModel('cursor/grok-4.6@high'), /no native CLI/);
    assert.throws(() => parseModel('grok-4.6'), /cannot tell/);
    assert.throws(() => parseModel('gpt-6.1-sol@ultra'), /unknown effort/);
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
      async request => { assert.equal(request.harness, 'native'); return { selected: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' }, strategy: 'jev' }; });
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
  it('reads pushed mail too: a push is only a pointer to the inbox', () => {
    store.appendMail('mb2', { id: '1', at: '', kind: 'message', from: { mailbox: 'x' }, text: 'a', pushed: true });
    store.appendMail('mb2', { id: '2', at: '', kind: 'message', from: { mailbox: 'x' }, text: 'b' });
    assert.deepEqual(mail.takeUnread('mb2').map(m => m.id), ['1', '2']);
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
  it('settles once when the hook and the sweep race on stale metadata', () => {
    const stale = run();
    writeResult('b-test', 'DONE');
    assert.equal(mail.settle('b-test'), 'queued');
    store.writeRun(stale); // the loser read meta before the winner wrote it
    assert.equal(mail.settle('b-test'), undefined);
    assert.equal(mail.takeUnread('claude-root').length, 1);
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
  it('settles a blocked child again when it goes on to finish', () => {
    run();
    writeResult('b-test', 'BLOCKED: which currency table?');
    mail.settle('b-test');
    assert.equal(store.readRun('b-test')?.state, 'blocked');
    writeResult('b-test', 'DONE: used the ISO table');
    assert.equal(runHook('stop', 'codex', '{"session_id":"t"}', { CREW_HOME: HOME, CREW_RUN: 'b-test' }), '');
    assert.equal(store.readRun('b-test')?.state, 'done');
    assert.deepEqual(mail.takeUnread('claude-root').map(m => m.text.replace(/^.*: /, '')), ['which currency table?', 'used the ISO table']);
  });
  it('holds a DONE written while an amendment is still unread, then settles once the child reads it', () => {
    run();
    writeFileSync(store.packetPath('b-test'), 'Build the retry path.\n');
    mail.amend(ROOT, 'b-test', 'Also keep the filter when retrying.');
    writeResult('b-test', 'DONE: amendments 1-3');
    assert.equal(mail.settle('b-test'), undefined);
    assert.equal(store.readRun('b-test')?.state, 'running');
    assert.deepEqual(mail.takeUnread('claude-root'), []);
    assert.equal(mail.takeUnread('b-test').length, 1); // the child's crew inbox
    assert.equal(mail.settle('b-test'), 'queued');
    assert.equal(store.readRun('b-test')?.state, 'done');
  });
  it('reopens a settled run whose result goes back to IN PROGRESS, telling the parent once', () => {
    run();
    writeResult('b-test', 'DONE: implemented');
    mail.settle('b-test');
    mail.takeUnread('claude-root');
    assert.equal(mail.reopen(store.readRun('b-test')!).state, 'done', 'a terminal result stays settled');
    writeResult('b-test', 'IN PROGRESS: amendment 4 pushed; waiting on CI');
    assert.equal(mail.reopen(store.readRun('b-test')!).state, 'running');
    assert.equal(store.readRun('b-test')?.state, 'running');
    const [notice] = mail.takeUnread('claude-root');
    assert.equal(notice?.kind, 'reopened');
    assert.match(notice?.text ?? '', /working again after settling DONE: implemented: IN PROGRESS: amendment 4/);
    writeResult('b-test', 'DONE: CI green');
    assert.equal(mail.settle('b-test'), 'queued');
    assert.equal(store.readRun('b-test')?.state, 'done');
    assert.match(mail.takeUnread('claude-root').map(m => m.text).join(), /CI green/);
  });
  it('settles a settled run again when it rewrites DONE without a sweep catching IN PROGRESS', () => {
    run();
    writeResult('b-test', 'DONE: amendments 1-3');
    mail.settle('b-test');
    mail.takeUnread('claude-root');
    writeResult('b-test', 'DONE: amendments 1-5, CI green');
    assert.equal(runHook('stop', 'claude', '{"session_id":"t"}', { CREW_HOME: HOME, CREW_RUN: 'b-test' }), '');
    assert.equal(store.readRun('b-test')?.state, 'done');
    assert.deepEqual(mail.takeUnread('claude-root').map(m => [m.kind, m.text.replace(/^.*: /, '')]), [['settled', 'amendments 1-5, CI green']]);
  });
  it('leaves kept teammates and unsettled drafts alone', () => {
    run({ keep: true, state: 'done', settled: { hash: 'h', at: new Date().toISOString(), status: 'DONE' } });
    writeResult('b-test', 'IN PROGRESS: next');
    assert.equal(mail.reopen(store.readRun('b-test')!).state, 'done');
    run({ id: 'b-two', name: 'builder-z', state: 'stopped', settled: { hash: 'h', at: new Date().toISOString(), status: 'DONE' } });
    writeResult('b-two', 'IN PROGRESS: next');
    assert.equal(mail.reopen(store.readRun('b-two')!).state, 'stopped', 'a stopped run stays stopped');
    assert.deepEqual(mail.takeUnread('claude-root'), []);
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
    run(); // a fresh, unclaimed run for the Codex session
    runHook('session-start', 'codex', '{"session_id":"t-9"}', env({ CREW_RUN: 'b-test' }));
    assert.equal(store.readRun('b-test')?.threadId, 't-9');
  });
  it('after compaction, sends an advisor back to its workflow and a crew child to its brief', () => {
    const state = mkdtempSync(join(tmpdir(), 'crew-advisor-'));
    mkdirSync(join(state, 'sessions'));
    writeFileSync(join(state, 'sessions', 'claude-code-s-7.md'), '# Advisor Session s-7\n\n- Workstream: `test-sweep`\n- Advisor mode: `cos`\n');
    const start = (host: 'claude' | 'codex', id: string, source: string, extra: Record<string, string> = {}) =>
      runHook('session-start', host, JSON.stringify({ session_id: id, source, cwd: '/repo' }), env({ ADVISOR_STATE_DIR: state, ...extra }));
    const out = start('claude', 's-7', 'compact');
    assert.match(out, /"hookEventName":"SessionStart"/);
    assert.match(out, /workstream `test-sweep` in CoS mode/);
    assert.match(out, /skills\/advisor\/SKILL\.md and \S+references\/team\.md/);
    assert.match(out, /CLAUDE_SESSION_ID=s-7 node \S+advisor-state-cli\.mjs read --cwd \\"\/repo\\"/);
    assert.doesNotMatch(out, /nothing is waiting/);
    run({ id: 'b-kid', name: 'kid', parent: { mailbox: 'claude-s-7', host: 'claude' } });
    assert.match(start('claude', 's-7', 'compact'), /nothing is waiting on kid\./);
    assert.equal(start('claude', 's-7', 'startup'), '');
    assert.equal(start('claude', 's-other', 'compact'), '');
    assert.equal(start('codex', 's-7', 'compact'), '', 'the pointer is per host');
    run();
    assert.match(start('codex', 't-9', 'compact', { CREW_RUN: 'b-test' }), /your brief: You are crew builder/);
    writeFileSync(store.briefPath('b-test'), 'brief\n');
    assert.match(start('codex', 't-9', 'compact', { CREW_RUN: 'b-test' }), /runs\/b-test\/brief\.md\).*runs\/b-test\/packet\.md/);
  });
  it('closes a finished herdr child pane after its turn, via the recorded session', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'crew-stub-'));
    const log = join(bin, 'calls');
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    const path = process.env.PATH;
    const herdrBinPath = process.env.HERDR_BIN_PATH;
    delete process.env.HERDR_BIN_PATH;
    process.env.PATH = `${bin}:${path}`; // the detached closer resolves herdr from this PATH, never the real one
    try {
      run({ launcher: 'herdr', herdr: { pane: 'w1:p9', agent: 'w1:p9', session: 'stub' } });
      writeResult('b-test', 'DONE');
      assert.equal(stop(false, { CREW_RUN: 'b-test', PATH: process.env.PATH! }), '');
      assert.equal(store.readRun('b-test')?.herdr?.closed, true);
      const calls = async (): Promise<string> => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
      for (let waited = 0; waited < 8_000 && !(await calls()); waited += 200) await new Promise(done => setTimeout(done, 200));
      assert.match(await calls(), /--session stub pane close w1:p9/);
    } finally {
      process.env.PATH = path;
      if (herdrBinPath) process.env.HERDR_BIN_PATH = herdrBinPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
  it('announces new mail to a busy child once per batch, after a tool call', () => {
    run({ keep: true });
    const post = (extra: Record<string, string>) => runHook('post-tool', 'codex', '{"session_id":"t-1"}', env(extra));
    assert.equal(post({ CREW_RUN: 'b-test' }), '');
    mail.send(ROOT, { mailbox: 'b-test', host: 'codex' }, 'widen the sweep to data');
    assert.match(post({ CREW_RUN: 'b-test' }), /"hookEventName":"PostToolUse".*1 unread crew mail from your parent/);
    assert.equal(post({ CREW_RUN: 'b-test' }), '');
    mail.send({ mailbox: 'a-peer', host: 'claude', name: 'peer' }, { mailbox: 'b-test', host: 'codex' }, 'fyi');
    assert.match(post({ CREW_RUN: 'b-test' }), /2 unread crew mail from your parent, peer/);
    assert.equal(post({}), '');
  });
  it('keeps a kept teammate going on IN PROGRESS, then reports it paused once', () => {
    run({ keep: true });
    writeResult('b-test', 'IN PROGRESS: batch 3 of 9 next');
    assert.match(stop(false, { CREW_RUN: 'b-test' }), /"decision":"block".*Keep going/);
    assert.equal(stop(true, { CREW_RUN: 'b-test' }), '');
    assert.equal(stop(true, { CREW_RUN: 'b-test' }), '');
    const notices = mail.takeUnread('claude-root');
    assert.deepEqual(notices.map(m => m.kind), ['waiting']);
    assert.match(notices[0]?.text ?? '', /paused mid-assignment \(IN PROGRESS: batch 3 of 9 next\)/);
    assert.equal(store.readRun('b-test')?.state, 'running');
    assert.equal(store.readRun('b-test')?.settled, undefined);
  });
  it('reports a one-shot run waiting on its own background work as paused, not stalled', () => {
    run();
    writeResult('b-test', 'IN PROGRESS: waiting on the Explore agent');
    assert.match(stop(false, { CREW_RUN: 'b-test' }), /"decision":"block".*Keep going/);
    assert.equal(stop(true, { CREW_RUN: 'b-test' }), '');
    assert.deepEqual(mail.takeUnread('claude-root').map(m => m.kind), ['waiting']);
    assert.equal(store.readRun('b-test')?.state, 'running');
    writeResult('b-test', 'DONE: listed');
    assert.equal(stop(false, { CREW_RUN: 'b-test' }), '');
    assert.equal(store.readRun('b-test')?.state, 'done');
  });
  it('never throws into the host', () => {
    assert.equal(runHook('stop', 'claude', '{not json', env()), '');
  });
});

describe('launch shape', () => {
  it('builds native argv per host with the bootstrap last', () => {
    const config = store.loadConfig();
    const claude = argv('claude', { host: 'claude', model: 'claude-opus-5-5', effort: 'high', strategy: 'jev' }, 'adv', config, 'GO');
    assert.deepEqual(claude.slice(0, 6), ['--model', 'claude-opus-5-5', '--effort', 'high', '--name', 'adv']);
    assert.deepEqual(claude.slice(-5), ['--add-dir', ROOT_DIR, '--permission-mode', 'auto', 'GO']);
    const codex = argv('codex', { host: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', strategy: 'jev' }, 'b', config, 'GO');
    assert.deepEqual(codex, ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', '-c', 'check_for_update_on_startup=false', 'GO']);
  });
  it('grants sandboxed children crew state and the checkout\'s git dir', () => {
    const repo = mkdtempSync(join(tmpdir(), 'crew-repo-'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const tree = join(tmpdir(), `crew-tree-${process.pid}`);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', tree]);
    try {
      assert.deepEqual(writableRoots(repo).map(root => realpathSync(root)), [realpathSync(HOME), realpathSync(join(repo, '.git'))]);
      assert.deepEqual(writableRoots(tmpdir()), [HOME]);
      const roots = writableRoots(tree);
      assert.equal(roots.length, 2);
      assert.equal(realpathSync(roots[1]!), realpathSync(join(repo, '.git')));
      const codex = argv('codex', { host: 'codex', model: 'gpt-6.1-sol', effort: 'high', strategy: 'jev' }, 'b', store.loadConfig(), 'GO', roots);
      assert.equal(codex[6], '-c');
      assert.match(codex[7] ?? '', /^sandbox_workspace_write\.writable_roots=\[".*"\]$/);
      const claude = argv('claude', { host: 'claude', model: 'opus', effort: 'high', strategy: 'jev' }, 'a', store.loadConfig(), 'GO', roots);
      assert.equal(claude.filter(arg => arg === '--add-dir').length, 3);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('points the child at its role skill, packet and result', () => {
    const text = bootstrap({ id: 'c-1', name: 'checker-1', role: 'checker', keep: false, parent: ROOT });
    assert.match(text, /skills\/advisor-role-checker\/SKILL\.md/);
    assert.match(text, /runs\/c-1\/packet\.md/);
    assert.match(text, /runs\/c-1\/result\.md/);
    assert.match(text, /crew msg parent/);
    assert.match(text, /\[amendment\] from your parent is part of your packet/);
    assert.match(text, /never placeholders/);
    assert.doesNotMatch(text, /IN PROGRESS: <next step>/);
    assert.match(bootstrap({ id: 'a-1', name: 'lead', role: 'advisor', keep: true, parent: ROOT }), /IN PROGRESS: <next step>/);
  });
  it('keeps the typed launch line inside what a loading shell holds', () => {
    // A shell still sourcing its rc files is in canonical tty mode and drops a line's tail past 1024 bytes.
    const run = { id: 'b-6annp2636', name: 'a-long-builder-name-for-testing', role: 'builder' as const };
    assert.match(firstPrompt(run), /runs\/b-6annp2636\/brief\.md$/);
    const roots = [HOME, '/Users/someone/Dev/company/monorepo-with-a-long-name/.git'];
    for (const host of ['claude', 'codex', 'opencode'] as const) {
      const r = { host, model: host === 'opencode' ? 'opencode/opencode-go/kimi-k3' : 'some-model', effort: 'xhigh' as const, strategy: 'jev' as const };
      const line = typedLine(host, argv(host, r, run.name, store.loadConfig(), firstPrompt(run), roots));
      assert.ok(Buffer.byteLength(line) < TTY_LINE_MAX / 2, `${host}: ${line.length} bytes`);
    }
    assert.equal(typedLine('codex', ['-c', 'a="b"', "it's"]), `codex -c 'a="b"' 'it'\\''s'`);
    assert.throws(() => startAgent('b', 'codex', 'w1:p1', ['x'.repeat(TTY_LINE_MAX)]), /launch line is \d+ bytes/);
  });
});

describe('trust', async () => {
  const trust = await import('../src/trust.ts');
  const files = () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-trust-'));
    const claude = join(dir, 'claude.json');
    const codex = join(dir, 'config.toml');
    writeFileSync(claude, JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true, allowedTools: [] } }, other: 1 }));
    writeFileSync(codex, 'model = "gpt-6.1-sol"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[projects."/b"]\ntrust_level = "untrusted"\n\n[projects."/c"]\nfoo = 1\n\n[mcp_servers.x]\ncommand = "x"\n');
    return { dir, claude, codex };
  };

  it('edits codex trust in place: flips, inserts and appends', () => {
    const f = files();
    const out = trust.codexTrust(readFileSync(f.codex, 'utf8'), ['/a', '/b', '/c', '/d']);
    assert.ok(trust.codexTrusted(out, '/b') && trust.codexTrusted(out, '/c') && trust.codexTrusted(out, '/d'));
    assert.doesNotMatch(out, /untrusted/);
    assert.match(out, /\[projects\."\/c"\]\ntrust_level = "trusted"\nfoo = 1/);
    assert.match(out, /\[mcp_servers\.x\]\ncommand = "x"/);
    assert.equal(out.match(/\[projects\."\/a"\]/g)?.length, 1);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('records trust in both files only where missing', () => {
    const f = files();
    const done = trust.trustPaths(['/a', '/b', '/e'], f);
    assert.deepEqual(done.claude, ['/b', '/e']);
    assert.deepEqual(done.codex, ['/b', '/e']);
    const state = JSON.parse(readFileSync(f.claude, 'utf8'));
    assert.equal(state.other, 1);
    assert.equal(state.projects['/e'].hasTrustDialogAccepted, true);
    assert.deepEqual(trust.trustPaths(['/a', '/b', '/e'], f), { claude: [], codex: [] });
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('finds checkouts and worktrees under a root, skipping dependency dirs', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-root-')));
    execFileSync('git', ['init', '-q', join(root, 'app')]);
    execFileSync('git', ['-C', join(root, 'app'), 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['-C', join(root, 'app'), 'worktree', 'add', '-q', join(root, 'app-worktrees', 'feat')]);
    execFileSync('git', ['init', '-q', join(root, 'app', 'node_modules', 'dep')]);
    const found = trust.checkouts(root);
    assert.deepEqual(found.sort(), [root, join(root, 'app'), join(root, 'app-worktrees', 'feat')].sort());
    assert.deepEqual(trust.trustTargets(join(root, 'app-worktrees', 'feat'), [root]), [join(root, 'app-worktrees', 'feat')]);
    assert.deepEqual(trust.trustTargets(join(root, 'app-worktrees', 'feat'), ['/nowhere'], { claude: '/none', codex: '/none' }), []);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('identity', async () => {
  const { self } = await import('../src/identity.ts');
  it('prefers a crew run, then the host session ids', () => {
    run();
    assert.equal(self({ CREW_RUN: 'b-test', CLAUDE_CODE_SESSION_ID: 'x' }).mailbox, 'b-test');
    assert.equal(self({ CREW_MAILBOX: 'claude-abc' }).mailbox, 'claude-abc');
    assert.deepEqual(self({ CODEX_THREAD_ID: 't1' }), { mailbox: 'codex-t1', host: 'codex', threadId: 't1' });
    // Codex launched from inside a Claude session inherits its CREW_MAILBOX; the thread id wins
    assert.equal(self({ CODEX_THREAD_ID: 't2', CREW_MAILBOX: 'claude-abc' }).mailbox, 'codex-t2');
    assert.deepEqual(self({ CLAUDE_CODE_SESSION_ID: 's1', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' }), { mailbox: 'claude-s1', host: 'claude', herdrAgent: 'w1:p2' });
  });
});

describe('router switch', async () => {
  const { routerSetting, setSessionRouter, setShellRouter, parseSwitch } = await import('../src/settings.ts');
  const { ancestry } = await import('../src/identity.ts');
  const me = { mailbox: 'claude-switch', host: 'claude' as const };
  const none = () => [];
  it('resolves env over session over config', () => {
    const config = store.loadConfig();
    assert.deepEqual(routerSetting(config, me, {}, none), { on: true, source: 'config' });
    setSessionRouter(me, false);
    assert.deepEqual(routerSetting(config, me, {}, none), { on: false, source: 'session' });
    assert.deepEqual(routerSetting(config, me, { CREW_ROUTER: 'on' }, none), { on: true, source: 'env' });
    setSessionRouter(me, undefined);
    assert.deepEqual(routerSetting(config, me, {}, none), { on: true, source: 'config' });
    assert.deepEqual(routerSetting({ ...config, router: { ...config.router, enabled: false } }, me, {}, none), { on: false, source: 'config' });
  });
  it('lets a terminal switch cover every session launched from that shell', () => {
    const config = store.loadConfig();
    const shell = process.pid; // alive, so the sweep keeps it
    setShellRouter(shell, false);
    // a session started from that shell: its crew calls see the shell among their ancestors
    assert.deepEqual(routerSetting(config, me, {}, () => [4242, shell, 1]), { on: false, source: 'shell', shell });
    assert.deepEqual(routerSetting(config, me, {}, () => [4242]), { on: true, source: 'config' });
    setSessionRouter(me, true);
    assert.equal(routerSetting(config, me, {}, () => [shell]).source, 'session');
    setSessionRouter(me, undefined);
    setShellRouter(shell, undefined);
    assert.equal(routerSetting(config, me, {}, () => [shell]).source, 'config');
  });
  it('sweeps switches left by exited shells', () => {
    const dir = join(HOME, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shell-999999.json'), '{"router":false}');
    setShellRouter(process.pid, false);
    assert.equal(existsSync(join(dir, 'shell-999999.json')), false);
    assert.equal(existsSync(join(dir, `shell-${process.pid}.json`)), true);
    setShellRouter(process.pid, undefined);
  });
  it('walks the real process ancestry', t => {
    const chain = ancestry(process.pid);
    if (!chain.length) return t.skip('ps is unavailable here (a sandbox)');
    assert.equal(chain[0]?.pid, process.pid);
    assert.equal(chain[1]?.pid, process.ppid);
  });
  it('parses switch words and ignores junk', () => {
    assert.equal(parseSwitch('OFF'), false);
    assert.equal(parseSwitch('1'), true);
    assert.equal(parseSwitch('maybe'), undefined);
  });
});

describe('checkpoint transfer', () => {
  it('resumes a workstream owned by a gone session only when its exact owner is named', () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-ckpt-'));
    const repo = join(home, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    const cli = join(ROOT_DIR, 'skills', 'advisor', 'scripts', 'advisor-state-cli.mjs');
    const run = (env: Record<string, string>, ...args: string[]) =>
      execFileSync(process.execPath, [cli, 'init', '--cwd', repo, '--workstream', 'tests', '--mode', 'cos', ...args],
        { env: { PATH: process.env.PATH!, HOME: home, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const oldOwner = '01a0d84d-4683-7499-9114-bebe61cef2db';
    run({ CODEX_THREAD_ID: oldOwner });
    const claude = { CLAUDE_SESSION_ID: '2d9a5f6b-b7a6-4088-b092-9629196cd4ea' };
    assert.throws(() => run(claude), /owned by codex session 01a0d84d/);
    assert.throws(() => run(claude, '--transfer-from', 'codex:00000000-0000-0000-0000-000000000000'), /owner-confirmed transfer/);
    const out = JSON.parse(run(claude, '--transfer-from', `codex:${oldOwner}`));
    assert.equal(out.state.sessionId, claude.CLAUDE_SESSION_ID);
    assert.equal(out.state.mode, 'cos');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('herdr layout', async () => {
  const { splitAway } = await import('../src/herdr.ts');
  const { childPanes } = await import('../src/spawn.ts');
  const stub = () => {
    const bin = mkdtempSync(join(tmpdir(), 'crew-herdr-'));
    const log = join(bin, 'calls');
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh
echo "$@" >> '${log}'
case "$*" in
  *"pane layout"*) echo '{"result":{"layout":{"panes":[{"pane_id":"w1:p2","rect":{"width":80,"height":50}},{"pane_id":"w1:p3","rect":{"width":160,"height":20}}]}}}' ;;
  *"pane split w1:pdead"*) echo "pane not found" >&2; exit 1 ;;
  *"pane split"*) echo '{"result":{"pane":{"pane_id":"w1:pnew"}}}' ;;
esac
`, { mode: 0o755 });
    const path = process.env.PATH, herdrBin = process.env.HERDR_BIN_PATH;
    delete process.env.HERDR_BIN_PATH;
    process.env.PATH = `${bin}:${path}`;
    return {
      calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(line => line.startsWith('pane split')),
      done: () => { process.env.PATH = path; if (herdrBin) process.env.HERDR_BIN_PATH = herdrBin; rmSync(bin, { recursive: true, force: true }); },
    };
  };

  it('splits the caller to the right when it has no child panes', () => {
    const s = stub();
    try {
      assert.equal(splitAway('w1:p1', [], '/tmp', { CREW_RUN: 'x' }), 'w1:pnew');
      assert.deepEqual(s.calls(), ['pane split w1:p1 --direction right --cwd /tmp --no-focus --env CREW_RUN=x']);
    } finally { s.done(); }
  });
  it('subdivides the newest live child, skipping dead ones, shaped by geometry', () => {
    const s = stub();
    try {
      assert.equal(splitAway('w1:p1', ['w1:pdead', 'w1:p2'], '/tmp', {}), 'w1:pnew');
      assert.deepEqual(s.calls(), ['pane split w1:pdead --direction right --cwd /tmp --no-focus', 'pane split w1:p2 --direction down --cwd /tmp --no-focus']);
    } finally { s.done(); }
  });
  it('orders a caller\'s open child panes newest first', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 26, 12, m)).toISOString();
    run({ id: 'b-1', createdAt: at(1), launcher: 'herdr', herdr: { pane: 'w1:p2', agent: 'w1:p2' } });
    run({ id: 'b-2', createdAt: at(2), launcher: 'herdr', herdr: { pane: 'w1:p3', agent: 'w1:p3', closed: true } });
    run({ id: 'b-3', createdAt: at(3), launcher: 'herdr', herdr: { pane: 'w1:p4', agent: 'w1:p4' } });
    run({ id: 'b-4', createdAt: at(4), launcher: 'herdr', herdr: { pane: 'w1:p5', agent: 'w1:p5', session: 'other' } });
    run({ id: 'b-5', createdAt: at(5), launcher: 'herdr', herdr: { pane: 'w1:p6', agent: 'w1:p6' }, parent: { mailbox: 'someone-else', host: 'claude' } });
    assert.deepEqual(childPanes('claude-root', undefined), ['w1:p4', 'w1:p2']);
    assert.deepEqual(childPanes('claude-root', undefined, 'b-3'), ['w1:p2']);
  });
  it('breaks a stale lock instead of waiting forever', () => {
    const dir = join(HOME, 'locks', 'split-test');
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(dir, old, old);
    assert.equal(store.withLock('split-test', () => 42, 1_000), 42);
    assert.equal(existsSync(dir), false);
  });
});

describe('amendments', () => {
  it('appends numbered amendments to the packet and mails them as packet content', () => {
    run();
    writeFileSync(store.packetPath('b-test'), 'Sweep the session lane.\n');
    const first = mail.amend(ROOT, 'builder-x', 'Test-script repairs are in scope.');
    const second = mail.amend(ROOT, 'b-test', 'Delete smoke-only suites.');
    assert.deepEqual([first.number, second.number], [1, 2]);
    const packet = readFileSync(store.packetPath('b-test'), 'utf8');
    assert.match(packet, /## Amendment 1 .*\n\nTest-script repairs are in scope\.\n\n## Amendment 2 /s);
    const [one] = mail.takeUnread('b-test');
    assert.equal(one?.kind, 'amendment');
    assert.match(mail.format(one!), /^\[amendment\] from root \(part of your packet\):\nAmendment 1/);
    assert.throws(() => mail.amend({ mailbox: 'a-peer', host: 'claude' }, 'b-test', 'x'), /only builder-x's parent/);
  });
});

describe('capacity', async () => {
  const { withinCapacity } = await import('../src/spawn.ts');
  const config = { ...store.loadConfig(), capacity: { claude: { max: 2, overflow: 'gpt-6.1-sol@high' } } };
  const opus = { host: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' as const, strategy: 'jev' as const };

  it('moves a routed spawn off a host at its cap', () => {
    assert.deepEqual(withinCapacity(opus, config, undefined, () => 1), opus);
    const moved = withinCapacity(opus, config, undefined, () => 2);
    assert.deepEqual({ ...moved, reason: undefined }, { host: 'codex', model: 'gpt-6.1-sol', effort: 'high', strategy: 'overflow', reason: undefined });
    assert.match(moved.reason ?? '', /claude has 2 live runs \(cap 2\)/);
    assert.equal(withinCapacity(opus, config, 'max', () => 3).effort, 'max');
  });
  it('leaves pins and uncapped hosts alone', () => {
    assert.deepEqual(withinCapacity({ ...opus, strategy: 'pinned' }, config, undefined, () => 9).host, 'claude');
    const sol = { host: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' as const, strategy: 'jev' as const };
    assert.deepEqual(withinCapacity(sol, config, undefined, () => 9), sol);
  });
});

describe('wakes', async () => {
  const { deliver } = mail;
  const { startAgent } = await import('../src/herdr.ts');
  const stub = () => {
    const bin = mkdtempSync(join(tmpdir(), 'crew-wake-'));
    const log = join(bin, 'calls');
    const starts = join(bin, 'starts');
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh
echo "$@" >> '${log}'
case "$*" in
  *"agent get"*) echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  *"agent start"*) echo x >> '${starts}'; [ "$(wc -l < '${starts}')" -gt 2 ] || { echo '{"error":{"code":"agent_pane_busy"}}' >&2; exit 1; } ;;
esac
`, { mode: 0o755 });
    const path = process.env.PATH, herdrBin = process.env.HERDR_BIN_PATH;
    delete process.env.HERDR_BIN_PATH;
    process.env.PATH = `${bin}:${path}`;
    return {
      calls: (verb: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []).filter(line => line.startsWith(verb)),
      done: () => { process.env.PATH = path; if (herdrBin) process.env.HERDR_BIN_PATH = herdrBin; rmSync(bin, { recursive: true, force: true }); },
    };
  };
  const letter = (text: string) => ({ id: text, at: new Date().toISOString(), kind: 'message' as const, from: { mailbox: 'b-test', name: 'lane' }, text });

  it('pushes one pointer per unread batch, never the stale text itself', () => {
    const s = stub();
    try {
      const idle = { mailbox: 'claude-busy', host: 'claude' as const, herdrAgent: 'w1:p1' };
      assert.deepEqual(['one', 'two', 'three'].map(text => deliver(idle, letter(text))), ['herdr-prompt', 'queued', 'queued']);
      assert.deepEqual(s.calls('agent prompt'), ['agent prompt w1:p1 [crew] new message from lane. Run: crew inbox']);
      assert.deepEqual(mail.takeUnread('claude-busy').map(m => m.text), ['one', 'two', 'three']);
      assert.equal(deliver(idle, letter('four')), 'herdr-prompt');
    } finally { s.done(); }
  });
  it('queues a Codex pointer for a root thread only, never for a run its hooks already reach', () => {
    const s = stub();
    try {
      const root = { mailbox: 'codex-01a0root', host: 'codex' as const, threadId: '01a0root' };
      assert.equal(deliver(root, letter('settled')), 'codex-queue');
      assert.deepEqual(s.calls('queue'), ['queue --thread 01a0root --message [crew] new message from lane. Run: crew inbox']);
      const child = mail.runAddress(run({ threadId: '01a0child', sessionId: '01a0child' }));
      assert.equal(deliver(child, letter('amend')), 'queued');
      assert.equal(mail.runAddress(run({ id: 'b-done', state: 'done', threadId: '01a0done' })).threadId, '01a0done');
      assert.equal(deliver(mail.runAddress(store.readRun('b-done')!), letter('late')), 'queued');
      assert.equal(s.calls('queue').length, 1, 'no pointer queued into a run thread');
      assert.deepEqual(mail.takeUnread('b-test').map(m => m.text), ['amend']);
    } finally { s.done(); }
  });
  it('retries agent start while a fresh pane is still loading its shell', () => {
    const s = stub();
    try {
      startAgent('lane', 'codex', 'w1:p7', ['--model', 'm', 'GO']);
      assert.equal(s.calls('agent start').length, 3);
    } finally { s.done(); }
  });
});

describe('waking the parent', async () => {
  const { waitHint } = await import('../src/wait.ts');
  it('tells a Claude parent to hold crew wait in the background, naming its live children', () => {
    assert.equal(waitHint(ROOT), undefined, 'no live children, nothing to say');
    run();
    run({ id: 'b-two', name: 'builder-z' });
    assert.match(waitHint(ROOT) ?? '', /nothing is waiting on builder-x, builder-z\. .*run_in_background, description "crew: builder-x, builder-z"/);
    const release = store.markWaiter(ROOT.mailbox);
    try { assert.equal(waitHint(ROOT), 'wake: your background crew wait covers builder-x, builder-z'); }
    finally { release(); }
    run({ parent: { mailbox: 'codex-t', host: 'codex' } });
    assert.equal(waitHint({ mailbox: 'codex-t', host: 'codex' }), 'wake: crew wait (live: builder-x)');
  });
});

describe('watcher', async () => {
  const { watch } = await import('../src/wait.ts');
  it('sweeps for a parent that is not waiting, then exits with no live children', async () => {
    run({ launcher: 'exec', pid: 999_999 }); // its process is gone
    run({ id: 'b-done', name: 'builder-y' });
    writeResult('b-done', 'DONE: shipped');
    await watch('claude-root', 10, 5_000);
    const kinds = mail.takeUnread('claude-root').map(m => `${m.from.name}:${m.kind}`).sort();
    assert.deepEqual(kinds, ['builder-x:stalled', 'builder-y:settled']);
    assert.equal(store.readRun('b-test')?.state, 'stalled');
  });
  it('starts one watcher for a parent that has never had mail', async () => {
    const { ensureWatcher } = await import('../src/wait.ts');
    ensureWatcher('claude-fresh'); // no live children: the watcher exits at once
    const pid = Number(readFileSync(join(store.mailDir('claude-fresh'), 'watcher'), 'utf8'));
    assert.ok(pid > 0);
    ensureWatcher('claude-fresh'); // idempotent while one may still be alive
  });
  it('leaves the sweep to an armed crew wait', async () => {
    run({ launcher: 'exec', pid: 999_999 });
    const release = store.markWaiter('claude-root');
    try { await watch('claude-root', 10, 100); } finally { release(); }
    assert.equal(store.readRun('b-test')?.state, 'running');
  });
});

describe('prompt-cache keepalive', async () => {
  const { keepaliveDue, transcriptPath, KEEPALIVE } = await import('../src/wait.ts');
  it('nudges just before each host\'s cache expires, and gives up when a rewrite is cheaper', () => {
    const minutes = (n: number) => n * 60_000;
    assert.equal(keepaliveDue('codex', minutes(24), 0), false);
    assert.equal(keepaliveDue('codex', minutes(25), 0), true);   // OpenAI: 30-minute cache
    assert.equal(keepaliveDue('claude', minutes(49), 0), false);
    assert.equal(keepaliveDue('claude', minutes(50), 0), true);  // Claude Code: 1-hour cache
    assert.equal(keepaliveDue('codex', minutes(90), KEEPALIVE.codex.max), false);
  });
  it('finds the transcript a host appends to for each session', () => {
    const codexHome = join(HOME, 'codex-home');
    const rollout = join(codexHome, 'sessions', '2026', '09', '27', 'rollout-2026-09-27T10-00-00-thread-9.jsonl');
    mkdirSync(join(rollout, '..'), { recursive: true });
    writeFileSync(rollout, '');
    assert.equal(transcriptPath({ mailbox: 'codex-thread-9', host: 'codex', threadId: 'thread-9' }, { CODEX_HOME: codexHome }), rollout);
    const claudeHome = join(HOME, 'claude-home');
    const session = join(claudeHome, 'projects', '-Users-me-repo', 'sess-1.jsonl');
    mkdirSync(join(session, '..'), { recursive: true });
    writeFileSync(session, '');
    assert.equal(transcriptPath({ mailbox: 'claude-sess-1', host: 'claude' }, { CLAUDE_CONFIG_DIR: claudeHome }), session);
    assert.equal(transcriptPath({ mailbox: 'claude-nope', host: 'claude' }, { CLAUDE_CONFIG_DIR: claudeHome }), undefined);
  });
});

describe('routing evidence', async () => {
  const { grade, outcomesPath } = await import('../src/outcome.ts');
  const sent = join(HOME, 'router-received.jsonl');
  const fake = join(HOME, 'fake-router.sh');
  const config = process.env.CREW_CONFIG!;
  const received = () => (existsSync(sent) ? readFileSync(sent, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  beforeEach(() => {
    writeFileSync(fake, `#!/bin/sh\n[ "$1 $2" = "outcomes record" ] || exit 2\ncat >> '${sent}'\necho >> '${sent}'\n`);
    chmodSync(fake, 0o755);
    writeFileSync(config, JSON.stringify({ router: { command: fake } }));
    rmSync(sent, { force: true }); rmSync(outcomesPath(), { force: true });
  });
  after(() => rmSync(config, { force: true }));

  const checker = (status: string, found?: string) => {
    run({ id: 'c-test', name: 'checker-y', role: 'checker', checks: 'b-test', route: { host: 'claude', model: 'claude-sonnet-5', effort: 'high', strategy: 'jev' } });
    writeFileSync(store.resultPath('c-test'), `# Status\n${status}\n${found ? `- **As found:** ${found}\n` : ''}\n# Claims\n- ok\n`);
    return mail.settle('c-test');
  };

  it('parses the as-found line in its usual spellings', () => {
    assert.equal(parseResult('# Status\nPASS\nAs found: HELD\n')?.found, 'held');
    assert.equal(parseResult('# Status\nPASS: repaired two\n- **As found:** FIXED\n')?.found, 'fixed');
    assert.equal(parseResult('## Status\nFAIL\n`As found: broken`\n')?.found, 'broken');
    assert.equal(parseResult('# Status\nPASS\n')?.found, undefined);
  });
  it("turns a checker's verdict into evidence about the checked run's model", () => {
    run();
    assert.equal(checker('PASS: repaired the rounding bug', 'FIXED'), 'queued');
    const [entry] = received();
    assert.equal(entry.model, 'gpt-6.1-sol'); assert.equal(entry.thinking, 'high'); assert.equal(entry.role, 'builder');
    assert.equal(entry.signal, 'review'); assert.equal(entry.success, false); assert.equal(entry.run, 'b-test');
    assert.match(entry.note, /checker-y: PASS/);
    assert.deepEqual(readFileSync(outcomesPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l)), [entry], 'kept locally too');
    assert.equal(mail.takeUnread('claude-root').length, 1, 'the parent still hears about it');
  });
  it('counts HELD for the work, a bare FAIL against it, and ignores a bare PASS or BLOCKED', () => {
    run(); checker('PASS', 'HELD');
    assert.deepEqual(received().map(e => e.success), [true]);
    rmSync(sent, { force: true }); checker('FAIL: two claims unproven');
    assert.deepEqual(received().map(e => e.success), [false]);
    rmSync(sent, { force: true }); checker('PASS');
    checker('BLOCKED: no staging access');
    assert.deepEqual(received(), []);
  });
  it('a run without --checks produces no evidence', () => {
    run({ id: 'c-test', role: 'checker' });
    writeResult('c-test', 'FAIL: broken');
    mail.settle('c-test');
    assert.deepEqual(received(), []);
  });
  it('grades: parent only, a person in a terminal may grade anything, and grading again replaces', () => {
    run();
    assert.throws(() => grade({ mailbox: 'someone-else', host: 'codex' }, 'b-test', true), /only builder-x's parent/);
    assert.equal(grade(ROOT, 'builder-x', false, 'missed the migration').routed, true);
    assert.equal(grade(undefined, 'b-test', true).run.grade?.good, true);
    const [first, second] = received();
    assert.equal(first.id, second.id, 'same id, so the router replaces the first grade');
    assert.equal(first.signal, 'grade'); assert.equal(first.success, false); assert.equal(first.note, 'missed the migration');
    assert.equal(second.success, true);
  });
  it('keeps the outcome locally when the router is missing', () => {
    writeFileSync(config, JSON.stringify({ router: { command: join(HOME, 'no-such-router') } }));
    run();
    assert.equal(grade(ROOT, 'b-test', true).routed, false);
    assert.equal(readFileSync(outcomesPath(), 'utf8').trim().split('\n').length, 1);
  });
  it('asks a --checks checker for the as-found line', () => {
    const text = bootstrap({ id: 'c-1', name: 'checker-y', role: 'checker', keep: false, parent: ROOT, checks: 'b-test' });
    assert.match(text, /checking the work of run b-test/);
    assert.match(text, /As found: HELD/);
    assert.doesNotMatch(bootstrap({ id: 'c-1', name: 'checker-y', role: 'checker', keep: false, parent: ROOT }), /As found/);
  });
});

describe('roster', async () => {
  const { loadRoster, rosterDefaults, unrunnable } = await import('../src/roster.ts');
  const file = join(HOME, 'roster.json');
  const entry = (model: string, roles: string[], extra: Record<string, unknown> = {}) => ({ model, effort: 'high', roles, cost: 0.5, use: 'things', ...extra });
  after(() => { process.env.CREW_ROSTER = join(HOME, 'no-roster.json'); rmSync(file, { force: true }); });

  it('parses host ids alongside the older provider prefixes', () => {
    assert.deepEqual(parseModel('codex/gpt-6.1-sol@high'), { host: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    assert.equal(parseModel('claude/claude-sonnet-5').host, 'claude');
    assert.match(unrunnable('devin/devin-2') ?? '', /no native CLI/);
    assert.equal(unrunnable('codex/gpt-6-luna'), undefined);
  });
  it('validates entries and names the bad one', () => {
    writeFileSync(file, JSON.stringify({ models: [entry('codex/gpt-6.1-sol', ['builder']), entry('sol', ['builder'])] }));
    assert.throws(() => loadRoster(file), /models\[1\]: model must be "<host>\/<model id>"/);
    writeFileSync(file, JSON.stringify({ models: [entry('codex/gpt-6.1-sol', ['maker'])] }));
    assert.throws(() => loadRoster(file), /roles must be/);
    writeFileSync(file, JSON.stringify({ models: [entry('codex/gpt-6.1-sol', ['builder'], { cost: 3 })] }));
    assert.throws(() => loadRoster(file), /cost must be 0..1/);
    assert.equal(loadRoster(join(HOME, 'absent.json')), undefined);
  });
  it('defaults each role to its first launchable, enabled model', () => {
    const roster = [
      entry('devin/devin-2', ['builder']), entry('codex/gpt-6-luna', ['checker'], { enabled: false }),
      entry('codex/gpt-6.1-sol', ['advisor', 'builder', 'checker']), entry('claude/claude-sonnet-5', ['checker']),
    ];
    assert.deepEqual(rosterDefaults(roster as never), { advisor: 'codex/gpt-6.1-sol@high', builder: 'codex/gpt-6.1-sol@high', checker: 'codex/gpt-6.1-sol@high' });
  });
  it('tells a missing router from one that rejects the roster, in the router\'s words', async () => {
    const { routerView } = await import('../src/roster.ts');
    const script = (name: string, body: string) => { const p = join(HOME, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
    assert.deepEqual(routerView(join(HOME, 'no-such-router'), file), { state: 'missing' });
    const rejects = script('router-rejects.sh', `echo '{"code":"AGENT_ROUTER_INVALID_INPUT","message":"roster models[3] (claude/x) about must be text of 1-200 characters (it is 207)"}' >&2; exit 1`);
    assert.deepEqual(routerView(rejects, file), { state: 'error', message: 'roster models[3] (claude/x) about must be text of 1-200 characters (it is 207)' });
    const reads = script('router-ok.sh', `[ "$1" = status ] && echo '{"rosterFile":"${file}"}' || echo '{}'`);
    assert.deepEqual(routerView(reads, file), { state: 'ok', rosterFile: file });
  });
  it('explicit defaults beat the roster, and a broken roster never breaks config loading', () => {
    process.env.CREW_ROSTER = file;
    writeFileSync(file, JSON.stringify({ models: [entry('claude/claude-sonnet-5', ['checker'])] }));
    writeFileSync(process.env.CREW_CONFIG!, JSON.stringify({ defaults: { builder: 'gpt-6-luna@max' } }));
    try {
      const { defaults } = store.loadConfig();
      assert.equal(defaults.checker, 'claude/claude-sonnet-5@high');
      assert.equal(defaults.builder, 'gpt-6-luna@max');
      assert.equal(defaults.advisor, 'claude-opus-5-5@high', 'built-in when neither says');
      writeFileSync(file, '{ not json');
      assert.equal(store.loadConfig().defaults.checker, 'gpt-6.1-sol@xhigh');
    } finally { rmSync(process.env.CREW_CONFIG!, { force: true }); }
  });
});

describe('opencode host', async () => {
  const { self, hookSelf } = await import('../src/identity.ts');
  const { opencodeEnv } = await import('../src/spawn.ts');
  const { chmodSync } = await import('node:fs');
  const route = { host: 'opencode' as const, model: 'opencode-go/kimi-k3', effort: 'max' as const, strategy: 'jev' as const };

  it('routes opencode/<provider>/<model> to OpenCode and keeps the provider in the model', () => {
    assert.deepEqual(parseModel('opencode/opencode-go/kimi-k3@max'), { host: 'opencode', model: 'opencode-go/kimi-k3', effort: 'max' });
  });
  it('launches the TUI with --prompt, or `opencode run` headless, with effort, file access and no update dialog in the env', () => {
    const config = store.loadConfig();
    assert.deepEqual(argv('opencode', route, 'b', config, 'GO'), ['--model', 'opencode-go/kimi-k3', '--prompt', 'GO']);
    assert.deepEqual(argv('opencode', route, 'b', config, 'GO', [], true), ['run', '--model', 'opencode-go/kimi-k3', '--variant', 'max', '--title', 'b', 'GO']);
    const content = JSON.parse(opencodeEnv(route, ['/tmp/crew', '/repo/.git']).OPENCODE_CONFIG_CONTENT!);
    assert.equal(content.autoupdate, false);
    assert.deepEqual(content.agent.build, { model: 'opencode-go/kimi-k3', variant: 'max' });
    assert.deepEqual(Object.keys(content.permission.external_directory), ['/tmp/crew/**', '/repo/.git/**', `${ROOT_DIR}/**`]);
    assert.ok(Object.values(content.permission.external_directory).every(v => v === 'allow'));
  });
  it('knows an OpenCode session from the env the plugin sets on its tool shells, ahead of inherited ones', () => {
    assert.deepEqual(self({ CREW_OPENCODE_SESSION: 'ses_1', CODEX_THREAD_ID: 'inherited', CREW_MAILBOX: 'claude-x' }), { mailbox: 'opencode-ses_1', host: 'opencode' });
    assert.equal(self({ CREW_MAILBOX: 'opencode-ses_2' }).host, 'opencode');
    assert.equal(hookSelf('opencode', 'ses_3', {})?.mailbox, 'opencode-ses_3');
    assert.equal(mail.resolve('opencode-ses_4', ROOT).host, 'opencode');
  });
  it("leaves the wake to the recipient's plugin", () => {
    assert.equal(mail.send(ROOT, { mailbox: 'opencode-ses_p', host: 'opencode' }, 'hello'), 'opencode-plugin');
    assert.equal(mail.takeUnread('opencode-ses_p').length, 1);
  });
  it('the plugin maps OpenCode events onto crew hooks, and wakes an idle session when mail lands', async () => {
    const calls = join(HOME, 'crew-calls.jsonl');
    const stub = join(HOME, 'crew-stub.sh');
    writeFileSync(stub, `#!/bin/sh\nin=$(cat)\nprintf '%s\\n' "{\\"args\\":\\"$*\\",\\"in\\":$in}" >> '${calls}'\n`
      + `case "$2" in stop) echo '{"decision":"block","reason":"write your result"}';; post-tool) echo '{"hookSpecificOutput":{"additionalContext":"[crew] 1 unread"}}';; esac\n`);
    chmodSync(stub, 0o755);
    Object.assign(process.env, { CREW_BIN: stub, CREW_RUN: 'b-test', CREW_OPENCODE_POLL_MS: '50' });
    const prompts: { path: { id: string }; body: { parts: { text: string }[] } }[] = [];
    try {
      const { CrewPlugin } = await import('../opencode/crew.js' as string);
      const plugin = await CrewPlugin({ client: { session: { promptAsync: async (b: never) => { prompts.push(b); } } } });
      const env: Record<string, string> = {};
      await plugin['shell.env']({ sessionID: 'ses_r', cwd: '/' }, { env });
      assert.deepEqual(env, { CREW_OPENCODE_SESSION: 'ses_r' });
      await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_r' } } } });
      await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_sub', parentID: 'ses_r' } } } });
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_sub' } } });
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_r' } } });
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_r' } } });
      const output = { title: 't', output: 'ran', metadata: {} };
      await plugin['tool.execute.after']({ tool: 'bash', sessionID: 'ses_r', callID: 'c' }, output);
      const seen = readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.deepEqual(seen.map(c => c.args), ['hook session-start --host opencode', 'hook stop --host opencode', 'hook stop --host opencode', 'hook post-tool --host opencode']);
      assert.deepEqual(seen[0].in, { session_id: 'ses_r' });
      assert.deepEqual([seen[1].in.stop_hook_active, seen[2].in.stop_hook_active], [false, true], 'the turn after a block is marked');
      assert.deepEqual(prompts.map(p => p.body.parts[0]!.text), ['write your result', 'write your result']);
      assert.equal(output.output, 'ran\n\n[crew] 1 unread');

      prompts.length = 0;
      const tick = () => new Promise(ok => setTimeout(ok, 150));
      await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_r', status: { type: 'busy' } } } });
      mail.send(ROOT, { mailbox: 'b-test', host: 'opencode' }, 'while busy');
      await tick();
      assert.equal(prompts.length, 0, 'a busy session is not interrupted; its turn end surfaces the mail');
      await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_r', status: { type: 'idle' } } } });
      await tick();
      assert.deepEqual(prompts.map(p => [p.path.id, p.body.parts[0]!.text]), [['ses_r', '[crew] new crew mail. Run: crew inbox']]);
      await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_r', status: { type: 'idle' } } } });
      await tick();
      assert.equal(prompts.length, 1, 'the same unread mail wakes once');
      mail.takeUnread('b-test');
      mail.send(ROOT, { mailbox: 'b-test', host: 'opencode' }, 'next');
      await tick();
      assert.equal(prompts.length, 2, 'new mail wakes again');
    } finally { for (const k of ['CREW_BIN', 'CREW_RUN', 'CREW_OPENCODE_POLL_MS']) delete process.env[k]; }
  });
});

describe('native subagents in crew runs', () => {
  const agent = (type?: string) => JSON.stringify({ tool_name: 'Agent', tool_input: type ? { subagent_type: type } : {} });
  it('refuses native work subagents inside a crew run and points at crew spawn', () => {
    run({ role: 'advisor' });
    for (const type of ['general-purpose', 'crew:advisor-maker', undefined]) {
      const out = JSON.parse(runHook('pre-agent', 'claude', agent(type), { CREW_HOME: HOME, CREW_RUN: 'b-test' }));
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /crew spawn --role/);
    }
  });
  it('allows read-only lookups, and leaves sessions outside crew runs alone', () => {
    run({ role: 'advisor' });
    assert.equal(runHook('pre-agent', 'claude', agent('Explore'), { CREW_HOME: HOME, CREW_RUN: 'b-test' }), '');
    assert.equal(runHook('pre-agent', 'claude', agent('general-purpose'), { CREW_HOME: HOME }), '');
  });
});

describe('an inherited CREW_RUN', async () => {
  const { ownRun, self } = await import('../src/identity.ts');
  const { bgInvocation } = await import('../src/spawn.ts');
  const env = (extra: Record<string, string> = {}) => ({ CREW_HOME: HOME, CREW_RUN: 'b-test', ...extra });
  const hookIn = (session: string, extra: object = {}) => JSON.stringify({ session_id: session, ...extra });
  it('binds a run to the first session that claims it; any other session carrying it is not that run', () => {
    run();
    runHook('session-start', 'claude', hookIn('s-own'), env());
    runHook('session-start', 'claude', hookIn('s-other'), env());
    assert.equal(store.readRun('b-test')?.sessionId, 's-own', 'a later session must not take the run over');
    assert.equal(ownRun(env(), 's-own')?.id, 'b-test');
    assert.equal(ownRun(env(), 's-other'), undefined);
    assert.equal(self(env({ CLAUDE_CODE_SESSION_ID: 's-other' })).mailbox, 'claude-s-other');
    assert.equal(self(env({ CLAUDE_CODE_SESSION_ID: 's-own' })).mailbox, 'b-test');
    const agent = (session: string) => runHook('pre-agent', 'claude', hookIn(session, { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }), env());
    assert.match(agent('s-own'), /"permissionDecision":"deny"/);
    assert.equal(agent('s-other'), '', 'a user session that merely inherited CREW_RUN keeps its subagents');
  });
  it('starts claude --bg with no session, run or herdr variables, and the run\'s env in --settings', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CREW_RUN: 'b-parent', HERDR_PANE_ID: 'w1:p1', CLAUDE_CODE_SESSION_ID: 's-parent', CODEX_THREAD_ID: 't-1', KEEP_ME: '1' });
    try {
      const call = bgInvocation(['--model', 'x', 'GO'], { CREW_RUN: 'b-child' });
      assert.deepEqual(call.argv, ['--bg', '--settings', '{"env":{"CREW_RUN":"b-child"}}', '--model', 'x', 'GO']);
      assert.deepEqual(Object.keys(call.env).filter(k => /^(CREW_|HERDR_|CLAUDE_CODE_)|^CODEX_THREAD_ID$/.test(k)), []);
      assert.equal(call.env.KEEP_ME, '1');
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
});
