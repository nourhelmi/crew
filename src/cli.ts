import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { closePane, herdr, inHerdr, labelPane } from './herdr.ts';
import { isHookEvent, runHook } from './hook.ts';
import { self } from './identity.ts';
import { format, resolve, send, takeUnread } from './mail.ts';
import { isEffort, route } from './route.ts';
import { spawn } from './spawn.ts';
import { checkouts, trustPaths, trustTargets } from './trust.ts';
import { routerSetting, setSessionRouter } from './settings.ts';
import { configPath, findRun, listRuns, loadConfig, readJson, resultPath, runDir, writeJson, writeRun } from './store.ts';
import { HOSTS, ROLES, type Address, type Host, type Role, type RunMeta } from './types.ts';
import { liveChildren, wait } from './wait.ts';

const HELP = `crew: advisor crews on native Claude Code and Codex

  crew spawn --role advisor|builder|checker (--task TEXT | --packet FILE | -- TEXT | stdin)
             [--model M[@effort]] [--effort E] [--name N] [--cwd DIR] [--keep] [--dry-run]
      Route (Jev unless --model), pick the CLI from the model, launch it (herdr pane,
      else claude --bg / codex exec). Prints the run.
  crew wait [--timeout 30m]    Block until a child settles/stalls or mail arrives; print it; exit.
                               Claude: run it as a background command, it wakes you on exit.
  crew msg <to> [TEXT... | --file F]   to = parent | run name | run id | mailbox
  crew inbox                   Print unread mail.
  crew ls [--all]              Your children (or everything).
  crew read <run>              Result, or the tail of its terminal/log.
  crew stop <run>              Stop a run and close its pane.
  crew route --role R --task T Show where a task would go, without launching.
  crew router [status|on|off|reset] [--global]
                               Jev routing for this session (children inherit), or globally.
                               CREW_ROUTER=off|on in the environment wins over both.
  crew trust [PATH... | --all] [--quiet]
                               Trust checkouts under the trust roots (default ~/Dev) in both CLIs.
  crew label <text>            Name this herdr pane (children are named role · name automatically).
  crew whoami                  This session's crew address.
  crew hook <event> --host claude|codex   (used by plugin hooks; reads stdin)`;

const safeSelf = (): Address | undefined => { try { return self(); } catch { return undefined; } };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function duration(text: string | undefined, fallbackMs: number): number {
  if (!text) return fallbackMs;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) fail(`crew: bad duration "${text}" (use 90s, 30m, 2h)`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms'] ?? 1;
  return Number(match[1]) * unit;
}

const stdin = (): string => (process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T {
  if (value && (allowed as readonly string[]).includes(value)) return value as T;
  return fail(`crew: --${what} must be one of ${allowed.join(', ')}`);
}

function age(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 60 ? `${minutes}m` : minutes < 2_880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1_440)}d`;
}

function row(run: RunMeta): string {
  const where = run.herdr ? `herdr:${run.herdr.agent}` : run.bgId ? `bg:${run.bgId}` : run.pid ? `exec:${run.pid}` : run.launcher;
  const last = run.settled ? `  "${run.settled.status.slice(0, 60)}"` : '';
  return `${run.name.padEnd(18)} ${run.id.padEnd(12)} ${run.role.padEnd(8)} ${`${run.route.host} ${run.route.model}@${run.route.effort}`.padEnd(30)} ${run.state.padEnd(8)} ${where.padEnd(16)} ${age(run.createdAt).padStart(4)}${run.keep ? ' kept' : ''}${last}`;
}

function tail(run: RunMeta): string {
  if (run.herdr && !run.herdr.closed) {
    const read = herdr(['agent', 'read', run.herdr.agent, '--source', 'recent-unwrapped', '--lines', '40'], 15_000, run.herdr.session);
    if (read.ok) return typeof read.json === 'string' ? read.json : JSON.stringify(read.json);
  }
  if (run.bgId) {
    try { return execFileSync('claude', ['logs', run.bgId], { encoding: 'utf8', timeout: 20_000 }).split('\n').slice(-40).join('\n'); }
    catch { /* fall through */ }
  }
  try { return readFileSync(`${runDir(run.id)}/exec.log`, 'utf8').split('\n').slice(-40).join('\n'); }
  catch { return '(no output captured)'; }
}

function stopRun(run: RunMeta): void {
  if (run.herdr && !run.herdr.closed) closePane(run.herdr.pane, run.herdr.session);
  if (run.bgId) { try { execFileSync('claude', ['stop', run.bgId], { stdio: 'ignore', timeout: 20_000 }); } catch { /* already gone */ } }
  if (run.pid) { try { process.kill(run.pid, 'SIGTERM'); } catch { /* already gone */ } }
  writeRun({ ...run, state: run.state === 'running' ? 'stopped' : run.state, ...(run.herdr ? { herdr: { ...run.herdr, closed: true } } : {}) });
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      role: { type: 'string' }, task: { type: 'string' }, packet: { type: 'string' }, model: { type: 'string' },
      effort: { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, keep: { type: 'boolean' },
      'dry-run': { type: 'boolean' }, timeout: { type: 'string' }, file: { type: 'string' }, all: { type: 'boolean' },
      host: { type: 'string' }, json: { type: 'boolean' }, quiet: { type: 'boolean' }, global: { type: 'boolean' },
    },
  });

  switch (command) {
    case 'spawn': {
      const role = oneOf<Role>(values.role, ROLES, 'role');
      const task = values.task ?? (values.packet ? readFileSync(values.packet, 'utf8') : positionals.length ? positionals.join(' ') : stdin());
      if (!task.trim()) fail('crew: give the task with --task, --packet FILE, or stdin');
      if (values.effort && !isEffort(values.effort)) fail(`crew: unknown effort "${values.effort}"`);
      const run = await spawn({
        role, task, cwd: resolvePath(values.cwd ?? process.cwd()), keep: Boolean(values.keep), dryRun: Boolean(values['dry-run']),
        ...(values.model ? { model: values.model } : {}), ...(values.effort && isEffort(values.effort) ? { effort: values.effort } : {}),
        ...(values.name ? { name: values.name } : {}),
      });
      if (values.json) { console.log(JSON.stringify(run)); return; }
      const where = run.herdr ? `herdr pane ${run.herdr.pane}` : run.bgId ? `claude --bg ${run.bgId}` : run.pid ? `codex exec pid ${run.pid}` : run.launcher;
      console.log(`${values['dry-run'] ? 'would spawn' : 'spawned'} ${run.name} (run ${run.id}): ${run.route.host} ${run.route.model}@${run.route.effort} [${run.route.strategy}] via ${where}`);
      if (run.route.reason && run.route.strategy === 'default') console.log(`  routing fell back to the role default: ${run.route.reason}`);
      if (!values['dry-run']) console.log(`  result: ${resultPath(run.id)}\n  wake: crew wait${run.parent.host === 'claude' ? ' (as a background command)' : ''}`);
      return;
    }
    case 'wait': {
      const timeoutMs = duration(values.timeout, 30 * 60_000);
      const mails = await wait(timeoutMs);
      if (mails.length) { console.log(mails.map(format).join('\n\n')); return; }
      const me = self();
      console.log(`no crew mail within ${values.timeout ?? '30m'}; live children: ${liveChildren(me.mailbox).map(run => run.name).join(', ') || 'none'}. Re-arm with crew wait if you still expect some.`);
      return;
    }
    case 'msg': {
      const [to, ...words] = positionals;
      if (!to) fail('crew: crew msg <to> TEXT');
      const text = values.file ? readFileSync(values.file, 'utf8') : words.length ? words.join(' ') : stdin();
      if (!text.trim()) fail('crew: empty message');
      const me = self();
      const target = resolve(to, me);
      console.log(`sent to ${target.name ?? target.mailbox}: ${send(me, target, text)}`);
      return;
    }
    case 'inbox': {
      const mails = takeUnread(self().mailbox);
      console.log(mails.length ? mails.map(format).join('\n\n') : 'no new mail');
      return;
    }
    case 'ls': {
      let runs = listRuns();
      if (!values.all) {
        const me = self();
        runs = runs.filter(run => run.parent.mailbox === me.mailbox && (run.state === 'running' || Date.now() - Date.parse(run.createdAt) < 86_400_000));
      }
      if (values.json) { console.log(JSON.stringify(runs)); return; }
      console.log(runs.length ? runs.map(row).join('\n') : 'no runs');
      return;
    }
    case 'read': {
      const run = findRun(positionals[0] ?? fail('crew: crew read <run>')) ?? fail('crew: no such run');
      let result: string | undefined;
      try { result = readFileSync(resultPath(run.id), 'utf8'); } catch { /* none yet */ }
      console.log(result ?? `no result yet (${run.state}); recent output:\n${tail(run)}`);
      return;
    }
    case 'stop': {
      const run = findRun(positionals[0] ?? fail('crew: crew stop <run>')) ?? fail('crew: no such run');
      stopRun(run);
      console.log(`stopped ${run.name}`);
      return;
    }
    case 'route': {
      const role = oneOf<Role>(values.role, ROLES, 'role');
      const task = values.task ?? (positionals.length ? positionals.join(' ') : stdin());
      const config = loadConfig();
      const router = routerSetting(config, safeSelf());
      const chosen = await route({ role, task, ...(values.model ? { model: values.model } : {}) }, { ...config, router: { ...config.router, enabled: router.on } });
      if (!router.on && chosen.strategy === 'default') chosen.reason = `router off (${router.source})`;
      console.log(JSON.stringify(chosen, null, 2));
      return;
    }
    case 'router': {
      const config = loadConfig();
      const action = positionals[0] ?? 'status';
      if (action === 'on' || action === 'off' || action === 'reset') {
        const on = action === 'reset' ? undefined : action === 'on';
        if (values.global) {
          if (on === undefined) fail('crew: --global takes on or off');
          const stored = readJson<Record<string, unknown> & { router?: Record<string, unknown> }>(configPath()) ?? {};
          writeJson(configPath(), { ...stored, router: { ...stored.router, enabled: on } });
        } else {
          setSessionRouter(self(), on);
        }
      } else if (action !== 'status') fail('crew: crew router [status|on|off|reset] [--global]');
      const setting = routerSetting(loadConfig(), safeSelf());
      console.log(`router: ${setting.on ? 'on' : 'off'} (${setting.source === 'env' ? 'CREW_ROUTER' : setting.source === 'session' ? 'this session' : 'config'})`);
      console.log(`  command: ${config.router.command} · defaults when off or failing: ${ROLES.map(role => `${role}=${config.defaults[role]}`).join(', ')}`);
      return;
    }
    case 'trust': {
      const config = loadConfig();
      const targets = values.all
        ? config.trust.roots.flatMap(root => checkouts(root))
        : (positionals.length ? positionals : [process.cwd()]).flatMap(path => trustTargets(resolvePath(path), config.trust.roots));
      const done = trustPaths(targets);
      if (!values.quiet) {
        console.log(`checked ${new Set(targets).size} path(s) under ${config.trust.roots.join(', ')}; newly trusted: claude ${done.claude.length}, codex ${done.codex.length}`);
        for (const path of new Set([...done.claude, ...done.codex])) console.log(`  ${path}`);
      }
      return;
    }
    case 'label': {
      const text = positionals.join(' ').trim();
      if (!text) fail('crew: crew label <text>');
      if (!inHerdr()) { console.log('not in a herdr pane; nothing to label'); return; }
      const ok = labelPane(process.env.HERDR_PANE_ID!, text, process.env.HERDR_SESSION);
      console.log(ok ? `labelled ${process.env.HERDR_PANE_ID}: ${text}` : 'herdr refused the label');
      return;
    }
    case 'whoami': {
      console.log(JSON.stringify(self(), null, 2));
      return;
    }
    case 'hook': {
      const event = positionals[0] ?? '';
      if (!isHookEvent(event)) fail(`crew: unknown hook event "${event}"`);
      const host = oneOf<Host>(values.host, HOSTS, 'host');
      process.stdout.write(runHook(event, host, stdin()));
      return;
    }
    default:
      console.log(HELP);
      if (command && command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 1;
  }
}

// The launcher's delegation guard must not leak into agents crew starts.
delete process.env.CREW_NO_DELEGATE;
// Hooks fired by GUI apps get a thin PATH. crew's tools live in ~/.local/bin (claude, herdr)
// and next to this node (codex, agent-router: npm globals that need node on PATH).
process.env.PATH = [join(homedir(), '.local', 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
main(process.argv.slice(2)).catch(error => fail((error as Error).message));
