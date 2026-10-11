import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConsoleBootstrap, ConsoleCommand, ConsoleDetail, ConsoleLaunch, ConsoleMutation, ConsoleUpdate } from '../src/console-types.ts';
import { hash, tinyInstructions, tinyVerifier } from './capture.ts';
import { scoreConsoleCapture } from './console-capture.ts';
import type { ConsoleCapture, ConsoleIdentity } from './console-capture.ts';
import { collect, executable, isolatedEnv, recorderShim, sanitizer, signalOwned } from './live.ts';
import type { LiveOptions } from './live.ts';
import { scenarios } from './scenarios.ts';
import type { Report } from './scenarios.ts';
import { unexecuted } from './score.ts';
import { setupIsolatedHookTrust } from './hook-trust.ts';
import { processExists, terminateOwnedProcess } from '../src/console-process.ts';
import type { OwnedProcess } from '../src/console-process.ts';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function provenance(): object {
  const files: { path: string; sha256: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(checkout, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path, sha256: hash(readFileSync(join(checkout, path), 'utf8')) });
    }
  };
  for (const dir of ['src', 'evals', 'skills']) walk(dir);
  for (const path of ['scripts/eval.ts', 'codex/hooks.json', 'bin/crew']) files.push({ path, sha256: hash(readFileSync(join(checkout, path), 'utf8')) });
  let revision = 'unknown'; let dirty = 'unknown';
  try {
    revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  } catch { /* Hashes still identify actual source bytes. */ }
  return { revision, dirty, files };
}

/** Minimal real HTTP adapter. Private state is read only from its own temporary CREW_HOME. */
export async function runConsoleLive(options: LiveOptions): Promise<{ report: Report; directory: string }> {
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(resolve(options.out), 'console-live-'));
  const startedAt = Date.now();
  const setupReport = (note: string, status: Report['status'] = 'blocked'): Report => ({
    schema: 1, surface: 'console-api', mode: 'live', proof: 'real-provider-tools', model: options.model,
    status, durationMs: Date.now() - startedAt, launchCount: 0, evidencePaths: ['contracts.json'],
    cases: scenarios.map(s => ({ ...unexecuted(s), ...(s.id === 'advisor-tiny-repair' ? { status } : {}) })), note,
  });
  const early = (note: string): { report: Report; directory: string } => {
    const report = setupReport(note);
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return { report, directory };
  };
  writeFileSync(join(directory, 'contracts.json'), JSON.stringify(provenance(), null, 2) + '\n', { mode: 0o600 });
  if (options.case && options.case !== 'advisor-tiny-repair') return early('Console API adapter covers advisor-tiny-repair only; requested case not executed.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return early('Invalid timeout; provider run not executed.');
  if (!/^(codex\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.model)) return early('Explicit valid Codex model required; provider run not executed.');
  if (!options.authFile) return early('Missing explicit --codex-auth-file. No auth was discovered or copied; provider run not executed.');
  const codex = options.codexBin ?? executable('codex');
  if (!codex) return early('Codex CLI unavailable; provider run not executed.');
  let auth: string;
  try {
    if (!lstatSync(options.authFile).isFile()) return early('Auth source must be a regular file, not a symlink.');
    auth = readFileSync(options.authFile, 'utf8');
    const value: unknown = JSON.parse(auth);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return early('Auth JSON has no credentials.');
  } catch { return early('Explicit auth source unavailable or invalid JSON. No provider run executed.'); }
  if (!existsSync(join(checkout, 'src/console-supervisor.ts'))) return early('Console runtime not integrated: src/console-supervisor.ts required.');
  let clean = sanitizer(auth);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crew-console-eval-')));
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(base), EVAL_BASE: base, EVAL_CREW: join(checkout, 'bin/crew'), EVAL_CODEX: codex, EVAL_CONSOLE: '1' };
  const workspace = join(base, 'workspace');
  const model = options.model.replace(/^codex\//, '');
  const launch: ConsoleLaunch = {
    requestId: `eval-launch-${randomBytes(12).toString('hex')}`, title: 'Synthetic advisor repair', cwd: workspace,
    mode: 'advisor', host: 'codex', model, effort: 'low', access: 'workspace',
    prompt: `Use real tools to repair only greeting.json to message="Hello world", preserving all other fields. Read ${join(checkout, 'skills/advisor/SKILL.md')} and its worker contract. Run existing immutable node verify.mjs from ${workspace} and record evidence in root-result.md. Work only in ${base}; Crew sources/skills are read-only. Choose staffing proportionally to this tiny task. Keep verify.mjs and AGENTS.md immutable. No personal state/auth reads, other daemons, external publishing or unrelated changes.`,
  };
  const capture: ConsoleCapture = { files: {}, beforeSecond: {}, runs: [], managedIds: [], providerRequests: [], receipts: [], http: [], identities: [], details: [], streams: [], launch };
  const privateEvidence: Record<string, string> = {};
  const log: string[] = [];
  let serverPid: number | undefined;
  let origin = ''; let token = ''; let sessionId = ''; let launched = false;
  let report: Report | undefined;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error('Timed out after 10000ms; isolated console setup incomplete.')), 10_000);
  const stop = (): void => controller.abort(new Error('Interrupted; owned console workflow stopped.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const supervisorGroups = (): number[] => {
    const root = join(base, 'crew/console/sessions');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap(id => {
      try { const meta = JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')); return Number.isSafeInteger(meta.pid) && meta.pid > 1 ? [meta.pid as number] : []; }
      catch { return []; }
    });
  };
  const providerHandles = (): OwnedProcess[] => {
    const root = join(base, 'crew/console/sessions');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap(id => {
      try {
        const provider = JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')).identity?.provider;
        return provider && Number.isSafeInteger(provider.pid) && provider.pid > 1 ? [provider as OwnedProcess] : [];
      } catch { return []; }
    });
  };
  const recoverOwnedLaunch = (): void => {
    // A POST can create the managed root before its HTTP response is lost/aborted.
    const root = join(base, 'crew/console/sessions');
    if (sessionId || !existsSync(root)) return;
    for (const id of readdirSync(root).filter(id => /^[A-Za-z0-9_-]+$/.test(id))) {
      const path = join(root, id, 'meta.json');
      try {
        const text = readFileSync(path, 'utf8'); const meta = JSON.parse(text);
        if (meta.launch?.requestId !== launch.requestId) continue;
        sessionId = id; launched = true;
        privateEvidence[`console/${id}/error-meta.json`] = text;
        privateEvidence[`console/${id}/error-view.json`] = readFileSync(join(root, id, 'view.json'), 'utf8');
        return;
      } catch { /* Incomplete/missing state remains a failed capture, not identity proof. */ }
    }
  };
  const providerEvidence = (): void => {
    const root = join(base, 'crew/console/sessions');
    capture.managedIds = existsSync(root) ? readdirSync(root).filter(id => /^[A-Za-z0-9_-]+$/.test(id)).sort() : [];
    const path = join(base, 'console-provider.jsonl');
    capture.providerRequests = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const request = async <T>(method: 'GET' | 'POST', path: string, body?: object, signal = controller.signal, record = true): Promise<T> => {
    const at = Date.now();
    const response = await fetch(origin + path, { method, signal, redirect: 'error',
      headers: method === 'POST' ? { Origin: origin, 'X-Crew-Token': token, 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value: unknown = await response.json();
    if (record) capture.http.push({ method, path, at, status: response.status, ...(body ? { request: body as ConsoleLaunch } : {}), response: value });
    if (!response.ok) throw new Error(`Console ${method} ${path} failed (${response.status}): ${JSON.stringify(value)}`);
    return value as T;
  };
  const waitFor = async <T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> => {
    while (true) {
      controller.signal.throwIfAborted();
      const value = await read();
      if (ready(value)) return value;
      await delay(100, undefined, { signal: controller.signal });
    }
  };
  const identity = (phase: ConsoleIdentity['phase'], detail: ConsoleDetail): void => {
    // Agreed with console-core: these files are backend-private, not a new public API.
    const dir = join(base, 'crew/console/sessions', sessionId);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { identity?: { sessionId?: string }; pid?: number; epoch?: string };
    const view = JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8')) as { commands: Record<string, ConsoleCommand> };
    const commandReceipts: ConsoleIdentity['commandReceipts'] = {};
    privateEvidence[`console/${sessionId}/${phase}-meta.json`] = JSON.stringify(meta, null, 2);
    privateEvidence[`console/${sessionId}/${phase}-view.json`] = readFileSync(join(dir, 'view.json'), 'utf8');
    const commands = join(dir, 'commands');
    if (existsSync(commands)) for (const file of readdirSync(commands).filter(f => f.endsWith('.json'))) {
      const text = readFileSync(join(commands, file), 'utf8');
      privateEvidence[`console/${sessionId}/${phase}-commands/${file}`] = text;
      commandReceipts[file.slice(0, -5)] = JSON.parse(text);
    }
    capture.identities.push({ phase, session: detail.session, ...(meta.identity?.sessionId ? { providerSessionId: meta.identity.sessionId } : {}), commands: view.commands, commandReceipts });
  };
  const streams: { close: () => Promise<void> }[] = [];
  const connect = async (connection: number): Promise<{ close: () => Promise<void> }> => {
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/events?session=${encodeURIComponent(sessionId)}&node=${encodeURIComponent(`console-${sessionId}`)}`,
      { signal: AbortSignal.any([controller.signal, abort.signal]), redirect: 'error' });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error(`Console SSE rejected (${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const task = (async () => {
      let pending = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data) as { console?: ConsoleUpdate };
          if (event.console) capture.streams.push({ connection, update: event.console });
        }
      }
    })();
    // Attach a rejection handler immediately; close surfaces unexpected transport errors.
    void task.catch(() => {});
    const stream = { close: async (): Promise<void> => {
      abort.abort();
      try { await task; } catch (error) { if (!abort.signal.aborted && !controller.signal.aborted) throw error; }
      await reader.cancel().catch(() => {});
    } };
    streams.push(stream); return stream;
  };
  const complete = async (requestId: string): Promise<ConsoleDetail> => waitFor(
    () => request<ConsoleDetail>('GET', `/api/console/sessions/${sessionId}`),
    detail => {
      if (['failed', 'closed', 'disconnected'].includes(detail.session.state)) throw new Error(`Console session ${detail.session.state}: ${detail.session.error ?? 'no details'}`);
      const input = detail.events.find(e => e.kind === 'user' && e.command?.requestId === requestId && e.command?.state === 'delivered');
      return detail.session.state === 'idle' && Boolean(input)
        && detail.events.some(e => e.kind === 'assistant' && !e.streaming && e.sequence > input!.sequence);
    });
  try {
    for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'CREW_HOME', 'ADVISOR_STATE_DIR']) mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
    mkdirSync(join(base, 'bin')); mkdirSync(join(base, 'home/.local/bin'), { recursive: true });
    for (const tool of ['crew', 'codex', 'node', 'herdr', 'claude', 'opencode', 'agent-router']) writeFileSync(join(base, 'bin', tool), recorderShim(true), { mode: 0o700 });
    symlinkSync(join(base, 'bin/crew'), join(base, 'home/.local/bin/crew'));
    writeFileSync(join(base, 'codex/auth.json'), auth, { mode: 0o600 });
    writeFileSync(join(base, 'codex/hooks.json'), readFileSync(join(checkout, 'codex/hooks.json')), { mode: 0o600 });
    const args = ['-c', 'approval_policy="never"', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([base])}`,
      '-c', 'sandbox_workspace_write.network_access=true', '-c', 'shell_environment_policy.inherit="all"', '-c', 'check_for_update_on_startup=false'];
    writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: false, command: join(base, 'bin/agent-router') },
      defaults: { advisor: `codex/${model}@low`, builder: `codex/${model}@low`, checker: `codex/${model}@low` },
      args: { codex: args, claude: [], opencode: [] }, trust: { roots: [] } }), { mode: 0o600 });
    writeFileSync(env.CREW_ROSTER!, JSON.stringify({ models: [{ model: `codex/${model}`, effort: 'low', roles: ['advisor', 'builder', 'checker'], cost: 0, use: 'Explicit isolated console eval model.' }] }), { mode: 0o600 });
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'greeting.json'), JSON.stringify({ message: 'Helo world', unchanged: 'preserve-me' }));
    writeFileSync(join(workspace, 'verify.mjs'), tinyVerifier);
    writeFileSync(join(workspace, 'AGENTS.md'), tinyInstructions);
    execFileSync('git', ['init', '-q', workspace], { env });
    execFileSync('git', ['-C', workspace, 'add', '.'], { env });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Eval', '-c', 'user.email=eval@invalid', 'commit', '-qm', 'synthetic inputs'], { env });
    try { execFileSync(join(base, 'bin/codex'), ['login', 'status'], { env, timeout: 10_000, stdio: 'pipe' }); }
    catch { throw new Error('Isolated Codex login status failed; explicit auth unavailable or unsupported. No provider run executed.'); }
    const hookTrust = await setupIsolatedHookTrust({ base, workspace, env, codexBin: codex,
      vettedHooksFile: join(checkout, 'codex/hooks.json'), signal: controller.signal });
    privateEvidence['hooks-trust.json'] = JSON.stringify(hookTrust, null, 2);
    const server = spawn(join(base, 'bin/crew'), ['console', '--port', '0'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    serverPid = server.pid;
    let serverError: Error | undefined;
    server.once('error', e => { serverError = e; });
    server.stdout.on('data', bytes => { const text = String(bytes); log.push(text); origin ||= text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? ''; });
    server.stderr.on('data', bytes => log.push(String(bytes)));
    await waitFor(() => origin, value => { if (serverError) throw serverError; if (server.exitCode !== null) throw new Error('Console HTTP server exited before binding.'); return Boolean(value); });
    const bootstrap = await request<ConsoleBootstrap>('GET', '/api/console', undefined, controller.signal, false);
    token = bootstrap.token;
    if (!token) throw new Error('Console bootstrap omitted mutation token.');
    clean = sanitizer(JSON.stringify({ auth: JSON.parse(auth), token }));
    const available = bootstrap.providers.find(p => p.id === 'codex');
    if (!available?.available) throw new Error(`Console Codex provider unavailable: ${available?.reason ?? 'provider not listed'}`);
    const mutation = await request<ConsoleMutation>('POST', '/api/console/sessions', launch);
    sessionId = mutation.session.id; launched = true;
    if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error('Unsafe managed session ID returned.');
    await request('POST', '/api/console/sessions', launch);
    // Bound setup separately; the behavioral deadline begins only after the
    // managed provider has acknowledged delivery of the initial human input.
    await waitFor(() => request<ConsoleDetail>('GET', `/api/console/sessions/${sessionId}`), detail => {
      if (['failed', 'closed', 'disconnected'].includes(detail.session.state)) throw new Error(`Console launch ${detail.session.state}: ${detail.session.error ?? 'no details'}`);
      return detail.events.some(e => e.kind === 'user' && e.command?.requestId === launch.requestId && e.command.state === 'delivered');
    });
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`Timed out after ${options.timeoutMs}ms; console provider workflow incomplete.`)), options.timeoutMs);
    const firstStream = await connect(1);
    const first = await complete(launch.requestId);
    capture.details.push({ phase: 'first', detail: first }); identity('first', first);
    await waitFor(() => capture.streams.filter(s => s.connection === 1).at(-1)?.update.detail,
      detail => Boolean(detail && first.events.every(e => detail.events.some(n => n.id === e.id && JSON.stringify(n) === JSON.stringify(e)))));
    await firstStream.close();
    capture.beforeSecond = collect(base).files;
    const firstCompletedAt = Date.now();
    const generatedAt = Date.now(); const nonce = randomBytes(24).toString('hex');
    const followup = { requestId: `eval-message-${randomBytes(12).toString('hex')}`,
      text: `Second human input. Create only followup.json with {"nonce":"${nonce}","message":"Hello world"}. Read the current repaired greeting.json and preserve its bytes. Do not change verify.mjs or AGENTS.md. Use real tools; finish after writing the fresh artifact.` };
    capture.followup = { request: followup, nonce, generatedAt, firstCompletedAt };
    await request('POST', `/api/console/sessions/${sessionId}/messages`, followup);
    await request('POST', `/api/console/sessions/${sessionId}/messages`, followup);
    const second = await complete(followup.requestId);
    capture.details.push({ phase: 'second', detail: second }); identity('second', second);
    await connect(2);
    await waitFor(() => capture.streams.filter(s => s.connection === 2).at(-1)?.update.detail,
      detail => Boolean(detail && second.events.every(e => detail.events.some(n => n.id === e.id && JSON.stringify(n) === JSON.stringify(e)))));
    const reconnected = await request<ConsoleDetail>('GET', `/api/console/sessions/${sessionId}`);
    capture.details.push({ phase: 'reconnected', detail: reconnected }); identity('reconnected', reconnected);
    const captured = collect(base);
    capture.files = captured.files; capture.receipts = captured.receipts; capture.runs = captured.runs;
    providerEvidence();
    report = scoreConsoleCapture(capture, options.model, Date.now() - startedAt);
    report.evidencePaths.push('contracts.json', 'console-server.log', 'hooks-trust.json');
  } catch (error) {
    recoverOwnedLaunch();
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    const note = clean(cause instanceof Error ? cause.message : String(cause)).split(base).join('<sandbox>');
    const captured = collect(base);
    capture.files = captured.files; capture.receipts = captured.receipts; capture.runs = captured.runs;
    providerEvidence();
    report = launched ? scoreConsoleCapture(capture, options.model, Date.now() - startedAt) : setupReport(note);
    report.status = launched ? 'fail' : 'blocked'; report.note = note;
  } finally {
    clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    for (const stream of streams) await stream.close().catch(() => {});
    let cleanupError = '';
    let closeReceipt: unknown;
    // HTTP-server shutdown intentionally leaves roots alive. Explicit close comes first.
    if (sessionId && origin && token) {
      try {
        const signal = AbortSignal.timeout(2500);
        const detail = await request<ConsoleDetail>('GET', `/api/console/sessions/${sessionId}`, undefined, signal, false);
        closeReceipt = await request('POST', `/api/console/sessions/${sessionId}/actions`, { requestId: `eval-close-${randomBytes(12).toString('hex')}`, action: 'close', revision: detail.session.revision }, signal, false);
      } catch (error) { cleanupError = clean(error instanceof Error ? error.message : String(error)); }
    }
    // Native hosts have separate owned groups. A failed/aborted HTTP close must
    // not leave them alive when the supervisor group is escalated.
    const providers = providerHandles();
    for (const provider of providers) {
      try { await terminateOwnedProcess(provider); }
      catch (error) { cleanupError ||= clean(error instanceof Error ? error.message : String(error)); }
    }
    let groups = supervisorGroups();
    signalOwned(base, serverPid, 'SIGTERM', groups); await delay(250);
    groups = [...new Set([...groups, ...supervisorGroups()])];
    signalOwned(base, serverPid, 'SIGKILL', groups);
    const save = (path: string, content: string): void => {
      const target = join(directory, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, clean(content), { mode: 0o600 });
    };
    try {
      // Include the real app-server/HTTP process receipts completed during shutdown.
      capture.receipts = collect(base).receipts;
      report ??= setupReport('Console adapter ended without a report.', launched ? 'fail' : 'blocked');
      if (cleanupError) { report.status = 'fail'; report.note += ` Explicit close failed: ${cleanupError}; owned isolated groups escalated.`; }
      save('cleanup.json', JSON.stringify({ serverPid, supervisorGroups: groups, providerPids: providers.map(p => p.pid),
        remainingProviderPids: providers.filter(p => processExists(p.pid)).map(p => p.pid), closeReceipt, error: cleanupError || undefined }, null, 2));
      report.evidencePaths.push('cleanup.json');
      save('console-capture.json', JSON.stringify(capture, null, 2)); save('console-server.log', log.join(''));
      for (const [path, content] of Object.entries(privateEvidence)) save(path, content);
      for (const [path, content] of Object.entries(capture.files)) save(path, content);
      save('report.json', JSON.stringify(report, null, 2) + '\n');
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
  return { report: report!, directory };
}
