// Idempotent installer: `node scripts/install.ts` (or `npm run install-crew`).
// Every file it edits is copied to ~/.crew/backups/<timestamp>/ first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../src/store.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const BACKUP = join(HOME, '.crew', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
const CREW_BIN = join(HOME, '.local', 'bin', 'crew');
const say = (message: string): void => console.log(`crew install: ${message}`);

const OLD_SKILLS = ['advisor', 'advisor-intelligence', 'advisor-role-advisor', 'advisor-role-builder', 'advisor-role-checker',
  'advisor-role-foreman', 'advisor-team', 'cos', 'meta-harness'];
const OLD_TRACE = /advisor-trace\.mjs/;

type HookCommand = { type: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type Hooks = Record<string, HookGroup[]>;

function backup(path: string): void {
  if (!existsSync(path)) return;
  mkdirSync(BACKUP, { recursive: true });
  copyFileSync(path, join(BACKUP, path.slice(HOME.length + 1).replaceAll('/', '__')));
}

const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

function link(target: string, path: string): void {
  if (isLink(path) && readlinkSync(path) === target) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) || isLink(path)) {
    if (!isLink(path)) backup(path);
    unlinkSync(path);
  }
  symlinkSync(target, path);
  say(`linked ${path} -> ${target}`);
}

/** Drop hook commands matching `drop`, then empty groups and events. */
function prune(hooks: Hooks, drop: (command: HookCommand) => boolean): Hooks {
  const out: Hooks = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !drop(hook)) })).filter(group => group.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }; }
  catch (error) { const e = error as { stdout?: string; stderr?: string }; return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}

// 1. crew on PATH for Codex, humans and scripts (the Claude plugin also puts its bin/ on PATH).
link(join(REPO, 'bin', 'crew'), CREW_BIN);

// 2. Retire the symlink farm into pi-meta-harness; the plugins now ship these skills.
for (const dir of ['.claude/skills', '.codex/skills', '.agents/skills'].map(d => join(HOME, d))) {
  for (const name of OLD_SKILLS) {
    const path = join(dir, name);
    if (isLink(path) && /pi-meta-harness|\/\.pi\//.test(readlinkSync(path))) { unlinkSync(path); say(`removed old skill link ${path}`); }
  }
}

// 3. Claude settings: re-enable background tasks, drop the old trace hooks (the plugin brings crew's).
{
  const path = join(HOME, '.claude', 'settings.json');
  const settings = readJson<{ env?: Record<string, string>; hooks?: Hooks }>(path);
  if (settings) {
    const before = JSON.stringify(settings);
    if (settings.env) {
      delete settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      if (!Object.keys(settings.env).length) delete settings.env;
    }
    if (settings.hooks) settings.hooks = prune(settings.hooks, hook => OLD_TRACE.test(hook.command ?? ''));
    if (JSON.stringify(settings) !== before) { backup(path); writeJson(path, settings); say('updated ~/.claude/settings.json (background tasks on, old trace hooks gone)'); }
  }
  const agent = join(HOME, '.claude', 'agents', 'advisor-maker.md');
  if (existsSync(agent) && !isLink(agent)) { backup(agent); renameSync(agent, join(BACKUP, 'claude-advisor-maker.md')); say('moved ~/.claude/agents/advisor-maker.md aside (the plugin provides it)'); }
}

// 4. Codex: maker role and hooks. Codex hooks live in ~/.codex/hooks.json and need a one-time trust in the TUI.
link(join(REPO, 'codex', 'agents', 'advisor-maker.toml'), join(HOME, '.codex', 'agents', 'advisor-maker.toml'));
{
  const path = join(HOME, '.codex', 'hooks.json');
  const file = readJson<{ hooks?: Hooks }>(path) ?? {};
  const before = JSON.stringify(file);
  const hooks = prune(file.hooks ?? {}, hook => OLD_TRACE.test(hook.command ?? '') || (hook.command ?? '').includes('crew" hook') || (hook.command ?? '').includes('/crew hook'));
  const crew = (event: string, timeout: number): HookCommand => ({ type: 'command', command: `"${CREW_BIN}" hook ${event} --host codex`, timeout });
  const add = (event: string, group: HookGroup): void => { hooks[event] = [...(hooks[event] ?? []), group]; };
  add('SessionStart', { hooks: [crew('session-start', 10)] });
  add('Stop', { hooks: [crew('stop', 30)] });
  add('SubagentStart', { matcher: 'advisor-maker', hooks: [crew('subagent-start', 10)] });
  add('SubagentStop', { matcher: 'advisor-maker', hooks: [crew('subagent-stop', 10)] });
  const next = { ...file, hooks };
  if (JSON.stringify(next) !== before) { backup(path); writeJson(path, next); say('updated ~/.codex/hooks.json (crew hooks in, old trace hooks out)'); }
}

// 5. Plugins from this repo as a local marketplace.
{
  const added = run('claude', ['plugin', 'marketplace', 'add', REPO]);
  if (!added.ok && !/already/i.test(added.out)) say(`claude marketplace add: ${added.out.trim()}`);
  run('claude', ['plugin', 'marketplace', 'update', 'crew']);
  const installed = run('claude', ['plugin', 'install', 'crew@crew']);
  say(installed.ok ? 'Claude plugin crew@crew installed' : `claude plugin install: ${installed.out.trim()}`);

  const codexAdded = run('codex', ['plugin', 'marketplace', 'add', REPO]);
  if (!codexAdded.ok && !/already/i.test(codexAdded.out)) say(`codex marketplace add: ${codexAdded.out.trim()}`);
  run('codex', ['plugin', 'marketplace', 'upgrade', 'crew']);
  const codexInstalled = run('codex', ['plugin', 'add', 'crew@crew']);
  say(codexInstalled.ok ? 'Codex plugin crew@crew installed' : `codex plugin add: ${codexInstalled.out.trim()}`);
}

// 6. Config with the defaults spelled out, never overwritten.
{
  const path = join(HOME, '.config', 'crew', 'config.json');
  if (!existsSync(path)) {
    writeJson(path, {
      defaults: { advisor: 'claude-opus-5-5@high', builder: 'gpt-6-sol@high', checker: 'gpt-6-sol@xhigh' },
      router: { enabled: true, command: 'agent-router', timeoutMs: 90000 },
      args: { claude: ['--permission-mode', 'auto'], codex: [] },
    });
    say(`wrote ${path}`);
  }
}

if (existsSync(BACKUP)) say(`backups in ${BACKUP}`);
say('done. Restart Claude Code and Codex sessions to pick up plugins and hooks.');
