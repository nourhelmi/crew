import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { closePane, herdr, inHerdr, labelPane } from './herdr.ts';
import { isHookEvent, runHook } from './hook.ts';
import { defaultCodexSocket, owningCodexSocket, self } from './identity.ts';
import { registerCodex, wakeCodex } from './codex-mail.ts';
import { amend, format, resolve, send, takeUnread } from './mail.ts';
import { resume } from './resume.ts';
import { grade } from './outcome.ts';
import { loadRoster, rosterPath, routerView, unrunnable } from './roster.ts';
import { isEffort, route } from './route.ts';
import { bgActive, hostEnv, liveOnHost, spawn } from './spawn.ts';
import { checkouts, trustPaths, trustTargets } from './trust.ts';
import { routerSetting, setSessionRouter, setShellRouter } from './settings.ts';
import { configPath, findRun, listRuns, loadConfig, readJson, resultPath, runDir, updateRun, writeJson } from './store.ts';
import { HOSTS, ROLES, type Address, type Host, type Role, type RunMeta } from './types.ts';
import { wait, waitHint, watch } from './wait.ts';

const HELP = `crew: advisor crews on native Claude Code and Codex

  crew spawn --role advisor|builder|checker (--task TEXT | --packet FILE | -- TEXT | stdin)
             [--model M[@effort]] [--effort E] [--name N] [--cwd DIR] [--keep] [--dry-run]
             [--checks RUN]
      Route (Jev unless --model), pick the CLI from the model, launch it (herdr pane,
      else claude --bg / codex exec). Prints the run. A checker given --checks RUN reports
      how RUN's work held up, and routing learns from it.
  crew wait [--timeout 30m]    Block until a child settles/stalls or mail arrives; print it; exit.
                               Claude: run it as a background command, it wakes you on exit.
  crew msg <to> [TEXT... | --file F]   to = parent | run name | run id | mailbox (advice)
  crew amend <run> [TEXT... | --file F] Append to your child's packet: scope, authorization, done-when.
  crew grade <run> good|bad [NOTE...]   Your verdict on a child's work; routing learns from it.
  crew inbox                   Print unread mail.
  crew connect --socket PATH   Connect this loaded Codex root to its owning Unix app server.
  crew ls [--all]              Your children (or everything).
  crew read <run>              Result, or the tail of its terminal/log.
  crew resume <run>            Resume an exited headless session with its recorded launch settings.
  crew stop <run>              Stop a run and close its pane.
  crew route --role R --task T Show where a task would go, without launching.
  crew router [status|on|off|reset] [--global]
                               Jev routing for this agent session, or (run in a plain terminal)
                               for every session launched from that shell; children inherit it.
                               --global edits the config; CREW_ROUTER=off|on in the env wins.
  crew roster [--json]         Your models per role, in preference order, with cost and track record.
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
    try { return execFileSync('claude', ['logs', run.bgId], { env: hostEnv(run.launch?.env), encoding: 'utf8', timeout: 20_000 }).split('\n').slice(-40).join('\n'); }
    catch { /* fall through */ }
  }
  try { return readFileSync(`${runDir(run.id)}/exec.log`, 'utf8').split('\n').slice(-40).join('\n'); }
  catch { return '(no output captured)'; }
}

function stopRun(run: RunMeta): void {
  const current = updateRun(run.id, live => ({ ...live, state: 'stopped' })) ?? run;
  if (current.herdr && !current.herdr.closed) {
    if (!closePane(current.herdr.pane, current.herdr.session)) throw new Error(`crew: ${current.name} is marked stopped, but its pane close failed; retry crew stop`);
    updateRun(current.id, live => live.herdr ? { ...live, herdr: { ...live.herdr, closed: true } } : undefined);
  }
  if (current.bgId) {
    try { execFileSync('claude', ['stop', current.bgId], { env: hostEnv(current.launch?.env), stdio: 'ignore', timeout: 20_000 }); }
    catch {
      if (bgActive(current.bgId, current.launch?.env) !== false) throw new Error(`crew: ${current.name} is marked stopped, but its background stop failed; retry crew stop`);
    }
  }
  if (current.pid) {
    try { process.kill(-current.pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
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
      checks: { type: 'string' }, socket: { type: 'string' },
    },
  });

  switch (command) {
    case 'wake-codex': {
      // Internal synchronous delivery adapter. No host discovery or thread takeover.
      try { console.log(await wakeCodex(JSON.parse(stdin()) as Address)); }
      catch { console.log('queued'); }
      return;
    }
    case 'connect': {
      const me = self();
      const socket = values.socket ?? me.codexSocket ?? (me.host === 'codex' ? owningCodexSocket() ?? defaultCodexSocket() : undefined);
      if (!socket) fail('crew: crew connect --socket /absolute/path/to/owning-app-server.sock');
      await registerCodex(me, socket);
      console.log(`connected ${me.mailbox} to ${socket}; loaded roots accept direct mail`);
      return;
    }
    case 'spawn': {
      const role = oneOf<Role>(values.role, ROLES, 'role');
      const task = values.task ?? (values.packet ? readFileSync(values.packet, 'utf8') : positionals.length ? positionals.join(' ') : stdin());
      if (!task.trim()) fail('crew: give the task with --task, --packet FILE, or stdin');
      if (values.effort && !isEffort(values.effort)) fail(`crew: unknown effort "${values.effort}"`);
      const run = await spawn({
        role, task, cwd: resolvePath(values.cwd ?? process.cwd()), keep: Boolean(values.keep), dryRun: Boolean(values['dry-run']),
        ...(values.model ? { model: values.model } : {}), ...(values.effort && isEffort(values.effort) ? { effort: values.effort } : {}),
        ...(values.name ? { name: values.name } : {}), ...(values.checks ? { checks: values.checks } : {}),
      });
      if (values.json) { console.log(JSON.stringify(run)); return; }
      const where = run.herdr ? `herdr pane ${run.herdr.pane}` : run.bgId ? `claude --bg ${run.bgId}` : run.pid ? `codex exec pid ${run.pid}` : run.launcher;
      console.log(`${values['dry-run'] ? 'would spawn' : 'spawned'} ${run.name} (run ${run.id}): ${run.route.host} ${run.route.model}@${run.route.effort} [${run.route.strategy}] via ${where}`);
      if (run.route.reason && run.route.strategy === 'default') console.log(`  routing fell back to the role default: ${run.route.reason}`);
      if (run.route.strategy === 'overflow') console.log(`  capacity: ${run.route.reason}`);
      const cap = loadConfig().capacity[run.route.host];
      const live = liveOnHost(run.route.host) + (values['dry-run'] ? 1 : 0);
      if (cap && run.route.strategy === 'pinned' && live > cap.max) {
        console.log(`  note: ${live} live ${run.route.host} runs, over the cap of ${cap.max}; they share one rate limit`);
      }
      if (!values['dry-run']) console.log(`  result: ${resultPath(run.id)}\n  ${waitHint(run.parent) ?? 'wake: crew wait'}`);
      return;
    }
    case 'wait': {
      const timeoutMs = duration(values.timeout, 30 * 60_000);
      const mails = await wait(timeoutMs);
      const me = self();
      if (mails.length) {
        // Checked after the wait has released: whatever still runs needs a fresh background wait.
        const hint = waitHint(me);
        console.log(mails.map(format).join('\n\n') + (hint ? `\n\n${hint}` : ''));
        return;
      }
      // For a Claude parent this timeout is also the prompt-cache heartbeat, so it must be re-armed in the background.
      console.log(`no crew mail within ${values.timeout ?? '30m'} (this wake also keeps your prompt cache warm).`
        + ` ${waitHint(me) ?? 'No live children, so nothing to re-arm.'}`);
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
    case 'amend': {
      const [ref, ...words] = positionals;
      if (!ref) fail('crew: crew amend <run> TEXT');
      const text = values.file ? readFileSync(values.file, 'utf8') : words.length ? words.join(' ') : stdin();
      if (!text.trim()) fail('crew: empty amendment');
      const { run, number, delivery } = amend(self(), ref, text);
      console.log(`amendment ${number} appended to ${run.name}'s packet: ${delivery}`);
      return;
    }
    case 'grade': {
      const [ref, verdict, ...words] = positionals;
      if (!ref || (verdict !== 'good' && verdict !== 'bad')) fail('crew: crew grade <run> good|bad [NOTE...]');
      const { run, routed } = grade(safeSelf(), ref, verdict === 'good', words.join(' '));
      console.log(`graded ${run.name} (${run.route.model}@${run.route.effort}, ${run.role}) ${verdict}${routed ? '' : '; router unavailable, kept in ~/.crew/outcomes.jsonl'}`);
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
    case 'resume': {
      const run = findRun(positionals[0] ?? '');
      if (!run) fail('crew: crew resume <run> (see crew ls)');
      const launched = await resume(run.id, !values.quiet);
      if (!values.quiet) console.log(`${run.name}: ${launched ? 'resumed' : 'already active or host unavailable'}`);
      break;
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
          // Inside an agent session: that session. In a plain terminal: this shell, so every
          // session launched from it (and their children) picks it up.
          const me = safeSelf();
          if (me) setSessionRouter(me, on);
          else setShellRouter(process.ppid, on);
        }
      } else if (action !== 'status') fail('crew: crew router [status|on|off|reset] [--global]');
      const setting = routerSetting(loadConfig(), safeSelf());
      const scope = {
        env: 'CREW_ROUTER in the environment',
        session: 'this session and the children it spawns',
        shell: `terminal shell ${setting.shell}: sessions launched from it and their children`,
        config: `config ${configPath()}`,
      }[setting.source];
      console.log(`router: ${setting.on ? 'on' : 'off'} (${scope})`);
      console.log(`  command: ${config.router.command} · defaults when off or failing: ${ROLES.map(role => `${role}=${config.defaults[role]}`).join(', ')}`);
      return;
    }
    case 'roster': {
      const path = rosterPath();
      const entries = loadRoster(path);
      if (!entries) {
        console.log(`no roster at ${path}. Write one with the roster skill (/crew:roster in Claude Code, $roster in Codex).`);
        return;
      }
      const command = loadConfig().router.command;
      const view = routerView(command, path);
      let stats: { candidate: string; role: string; outcomes: number; successes: number }[] | undefined;
      if (view.state === 'ok') {
        try { stats = JSON.parse(execFileSync(command, ['outcomes', 'stats'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 })).candidates; }
        catch { /* no track records yet */ }
      }
      if (values.json) { console.log(JSON.stringify({ path, models: entries, router: view, stats: stats ?? [] })); return; }
      const reads = view.state === 'missing' ? 'router not installed: spawns use the first model per role'
        : view.state === 'error' ? 'THE ROUTER REJECTS IT: every spawn falls back to the first model per role'
        : view.rosterFile === path ? 'the router reads it'
        : `the router uses its own catalog; switch with: ${command} roster use --file ${path}`;
      console.log(`roster ${path} · ${reads}`);
      if (view.state === 'error') console.log(`  ! router: ${view.message}`);
      for (const role of ROLES) {
        const mine = entries.filter(e => e.roles.includes(role));
        mine.forEach((e, index) => {
          const id = `${e.model}@${e.effort}`;
          const record = stats?.find(s => s.candidate === id && s.role === role);
          const notes = [e.enabled === false ? 'off' : '', e.scope ? 'small/verify only' : '', record ? `track ${record.successes}/${record.outcomes}` : ''].filter(Boolean);
          console.log(`  ${(index ? '' : role).padEnd(8)} ${id.padEnd(42)} cost ${e.cost.toFixed(2)}${notes.length ? `  ${notes.join(' · ')}` : ''}`);
        });
      }
      const problems = [...new Set(entries.map(e => e.model))].flatMap(model => { const why = unrunnable(model); return why ? [`${model}: ${why}`] : []; });
      for (const problem of problems) console.log(`  ! ${problem}`);
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
    case 'watch': {
      // Internal: started detached by spawn, one per parent mailbox.
      await watch(positionals[0] ?? fail('crew: crew watch <mailbox>'));
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
process.env.PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), dirname(process.execPath)].join(delimiter);
main(process.argv.slice(2)).catch(error => fail((error as Error).message));
