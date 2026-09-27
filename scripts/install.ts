// Idempotent installer: `node scripts/install.ts [--trust-root <dir>]...` (or `npm run setup -- …`).
// Every file it edits is copied to ~/.crew/backups/<timestamp>/ first.
// --trust-root opts into "never show a folder-trust dialog for checkouts under <dir>" (e.g. ~/Dev).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../src/store.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const BACKUP = join(HOME, '.crew', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
const CREW_BIN = join(HOME, '.local', 'bin', 'crew');
// `npm run` prepends every ancestor node_modules/.bin; a stale npm Claude Code there must not win.
const CLAUDE = existsSync(join(HOME, '.local', 'bin', 'claude')) ? join(HOME, '.local', 'bin', 'claude') : 'claude';
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

// 4. Codex: maker role. Crew's Codex hooks ship in the plugin (codex/hooks.json); strip old copies from hooks.json.
link(join(REPO, 'codex', 'agents', 'advisor-maker.toml'), join(HOME, '.codex', 'agents', 'advisor-maker.toml'));
{
  const path = join(HOME, '.codex', 'hooks.json');
  const file = readJson<{ hooks?: Hooks }>(path);
  if (file?.hooks) {
    const before = JSON.stringify(file);
    const hooks = prune(file.hooks, hook => OLD_TRACE.test(hook.command ?? '') || /crew"? hook /.test(hook.command ?? ''));
    const next = { ...file, hooks };
    if (JSON.stringify(next) !== before) { backup(path); writeJson(path, next); say('updated ~/.codex/hooks.json (old trace and duplicate crew hooks out)'); }
  }
}

// 4b. Codex sandbox: crew's state dir is writable, and `crew` itself is pre-approved to run
//     unsandboxed (it launches agents and talks to herdr and the Codex daemon).
{
  const rules = join(HOME, '.codex', 'rules', 'crew.rules');
  const ruleText = '# crew: advisor orchestration CLI. Managed by crew scripts/install.ts.\nprefix_rule(pattern=["crew"], decision="allow")\n';
  if (!existsSync(rules) || readFileSync(rules, 'utf8') !== ruleText) {
    mkdirSync(dirname(rules), { recursive: true });
    writeFileSync(rules, ruleText);
    say('wrote ~/.codex/rules/crew.rules (crew runs without approval prompts)');
  }
  const path = join(HOME, '.codex', 'config.toml');
  const crewHome = join(HOME, '.crew');
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    let at = lines.findIndex(line => line.trim() === '[sandbox_workspace_write]');
    if (at < 0) { lines.push('', '[sandbox_workspace_write]'); at = lines.length - 1; }
    let end = at + 1;
    while (end < lines.length && !lines[end]!.trimStart().startsWith('[')) end++;
    const rootsAt = lines.slice(at + 1, end).findIndex(line => /^\s*writable_roots\s*=/.test(line));
    if (rootsAt < 0) lines.splice(at + 1, 0, `writable_roots = [${JSON.stringify(crewHome)}]`);
    else if (!lines[at + 1 + rootsAt]!.includes(JSON.stringify(crewHome))) {
      lines[at + 1 + rootsAt] = lines[at + 1 + rootsAt]!.replace(/\[\s*/, `[${JSON.stringify(crewHome)}, `).replace(', ]', ']');
    }
    const next = lines.join('\n');
    if (next !== text) { backup(path); writeFileSync(path, next); say('added ~/.crew to Codex sandbox writable_roots'); }
  }
}

// 5. Plugins from this repo as a local marketplace.
{
  const added = run(CLAUDE, ['plugin', 'marketplace', 'add', REPO]);
  if (!added.ok && !/already/i.test(added.out)) say(`claude marketplace add: ${added.out.trim()}`);
  run(CLAUDE, ['plugin', 'marketplace', 'update', 'crew']);
  const installed = run(CLAUDE, ['plugin', 'install', 'crew@crew']);
  const updated = run(CLAUDE, ['plugin', 'update', 'crew@crew']);
  say(installed.ok || updated.ok ? 'Claude plugin crew@crew installed/updated' : `claude plugin install: ${installed.out.trim()}`);

  const codexAdded = run('codex', ['plugin', 'marketplace', 'add', REPO]);
  if (!codexAdded.ok && !/already/i.test(codexAdded.out)) say(`codex marketplace add: ${codexAdded.out.trim()}`);
  run('codex', ['plugin', 'marketplace', 'upgrade', 'crew']);
  const codexInstalled = run('codex', ['plugin', 'add', 'crew@crew']);
  say(codexInstalled.ok ? 'Codex plugin crew@crew installed' : `codex plugin add: ${codexInstalled.out.trim()}`);
}

// 5b. OpenCode, when installed: crew's plugin (its hooks), the skills, and a command per entry skill.
{
  const home = join(HOME, '.config', 'opencode');
  if (existsSync(home) || run('opencode', ['--version']).ok) {
    link(join(REPO, 'opencode', 'crew.js'), join(home, 'plugins', 'crew.js'));
    for (const name of readdirSync(join(REPO, 'skills'))) link(join(REPO, 'skills', name), join(home, 'skills', name));
    for (const name of ['advisor', 'cos', 'roster', 'router']) {
      const description = readFileSync(join(REPO, 'skills', name, 'SKILL.md'), 'utf8').match(/^description:\s*(.+)$/m)?.[1] ?? name;
      const body = `---\ndescription: ${description}\n---\n<!-- managed by crew scripts/install.ts -->\nLoad the crew \`${name}\` skill and follow it. Arguments: $ARGUMENTS\n`;
      const path = join(home, 'commands', `${name}.md`);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
        if (existsSync(path) && !readFileSync(path, 'utf8').includes('managed by crew')) { say(`left ${path} alone (not crew's)`); continue; }
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); say(`wrote ${path}`);
      }
    }
    say('OpenCode: crew plugin, skills and /advisor /cos /roster /router commands installed');
  }
}

// 6. Config with the defaults spelled out; existing settings are kept, --trust-root adds roots.
const CONFIG = join(HOME, '.config', 'crew', 'config.json');
const requestedRoots = process.argv.flatMap((arg, i, all) => (arg === '--trust-root' && all[i + 1] ? [all[i + 1]!] : []))
  .map(root => resolve(root.replace(/^~(?=\/|$)/, HOME)).replace(HOME, '~'));
{
  type Stored = { trust?: { roots?: string[] } } & Record<string, unknown>;
  const current = readJson<Stored>(CONFIG) ?? {
    defaults: { advisor: 'claude-opus-5-5@high', builder: 'gpt-6-sol@high', checker: 'gpt-6-sol@xhigh' },
    router: { enabled: true, command: 'agent-router', timeoutMs: 90000 },
    args: { claude: ['--permission-mode', 'auto'], codex: [], opencode: [] },
  };
  const roots = [...new Set([...(current.trust?.roots ?? []), ...requestedRoots])];
  const next: Stored = { ...current, trust: { roots } };
  if (!existsSync(CONFIG) || JSON.stringify(next) !== JSON.stringify(current)) { writeJson(CONFIG, next); say(`wrote ${CONFIG}`); }
}
const trustRoots = readJson<{ trust?: { roots?: string[] } }>(CONFIG)?.trust?.roots ?? [];

// 7. Opt-in: no folder-trust dialogs under the trust roots. Backfill now, wrap the shell
//    launchers for brand-new checkouts, and re-sweep every 10 minutes for the desktop apps.
if (!trustRoots.length) say('no trust roots configured; folder-trust dialogs are left alone (see --trust-root)');
else {
  const swept = run(CREW_BIN, ['trust', '--all']);
  say(swept.ok ? swept.out.split('\n')[0]!.trim() : `crew trust --all: ${swept.out.trim()}`);

  const rc = join(HOME, '.zshrc');
  const block = [
    '# >>> crew trust >>>',
    '# Trust new checkouts under the crew trust roots before an agent CLI can ask.',
    'claude() { command crew trust --quiet "$PWD" >/dev/null 2>&1; command claude "$@"; }',
    'codex() { command crew trust --quiet "$PWD" >/dev/null 2>&1; command codex "$@"; }',
    '# <<< crew trust <<<',
  ].join('\n');
  const text = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
  const marked = /# >>> crew trust >>>[\s\S]*?# <<< crew trust <<<\n?/;
  const next = marked.test(text) ? text.replace(marked, `${block}\n`) : `${text.replace(/\n*$/, '\n')}\n${block}\n`;
  if (next !== text) { backup(rc); writeFileSync(rc, next); say('added claude/codex trust wrappers to ~/.zshrc'); }

  const label = 'dev.crew.trust';
  const plist = join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${CREW_BIN}</string><string>trust</string><string>--all</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${join(HOME, '.crew', 'trust.log')}</string>
</dict>
</plist>
`;
  const current = existsSync(plist) ? readFileSync(plist, 'utf8') : '';
  if (current !== body) {
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, body);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    run('launchctl', ['bootout', `${domain}/${label}`]);
    const loaded = run('launchctl', ['bootstrap', domain, plist]);
    say(loaded.ok ? `launchd ${label}: re-trusts new checkouts every 10 minutes` : `launchctl bootstrap: ${loaded.out.trim()}`);
  }
}

if (existsSync(BACKUP)) say(`backups in ${BACKUP}`);
say('done. Restart Claude Code, Codex and OpenCode sessions to pick up plugins and hooks.');
