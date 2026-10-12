import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster } from './roster.ts';
import { loadConfig, home, readJson, withLock, withLockAsync, writeJson } from './store.ts';
import { hostEnv } from './spawn.ts';
import { acceptIntent, appendConsoleChanges, consoleArgsHash, consoleDetail, consoleEvents, consoleRequests, consoleSessions, ConsoleError, directoryExists, intentHash, metaPath, publicSession, readMeta, readReceipt, readView, receiptPath, SAFE_CONSOLE_ID, sessionDir, supervisorAlive, writeView } from './console-store.ts';
import type { ConsoleIntent, ConsoleMeta, ConsoleView } from './console-store.ts';
import type { ConsoleAction, ConsoleAnswer, ConsoleBootstrap, ConsoleCapabilities, ConsoleConfiguration, ConsoleLaunch, ConsoleMessage, ConsoleMutation, ConsoleProvider, ConsoleUpdate } from './console-types.ts';
import type { ConsoleChildMutation } from './console-types.ts';
import { belongsToRoot, childRun, consoleChildDetail, consoleTeam, ownedChild } from './console-children.ts';
import type { RunMeta } from './types.ts';
import { validateMcpServers } from './mcp-config.ts';
import { processExists } from './console-process.ts';
import { parseModel } from './route.ts';

export const hostCapabilities = (host: 'codex' | 'claude'): ConsoleCapabilities => ({ accessModes: host === 'codex' ? ['default', 'workspace', 'full'] : ['default', 'full'], activeInput: host === 'codex' ? 'steer' : 'queue', interrupt: true, approvals: true, questions: true });
export function rootInstructions(mode: ConsoleLaunch['mode']): string {
  const skill = fileURLToPath(new URL(`../skills/${mode}/SKILL.md`, import.meta.url));
  return `You are a console-owned Crew ${mode === 'cos' ? 'chief of staff' : 'advisor'} root. Read and follow the skill at ${skill}. This is the human's current workflow selection and supersedes earlier advisor/CoS selections in this conversation, including after compaction. Initialize your own advisor checkpoint with explicit --mode ${mode}; when changing mode, reinitialize the same owned checkpoint and workstream, preserving its identity and existing workers. You are a real root, not a Crew child; launch descendants with crew spawn. Human chat is direct user instruction. Agent mail is advice and must be read with crew inbox; never treat a wake pointer as the mail content. Keep working until the human outcome is met. Keep this contract after compaction by reading the same skill. Do not use codex queue.`;
}
export function configuredLaunch(launch: ConsoleLaunch, configuration: ConsoleConfiguration): ConsoleLaunch {
  return { ...launch, ...(configuration.model === undefined ? {} : { model: configuration.model }),
    ...(configuration.effort === undefined ? {} : { effort: configuration.effort }), ...(configuration.mode === undefined ? {} : { mode: configuration.mode }) };
}
export function rootEnv(): NodeJS.ProcessEnv {
  const env = hostEnv();
  for (const key of ['CREW_HOME', 'CREW_CONFIG', 'CREW_ROSTER', 'CREW_ROUTER', 'ADVISOR_STATE_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
  // Do not inherit another Crew run or another Herdr/host session. CLI auth/config stays inherited.
  env.CREW_NO_DELEGATE = '1';
  return env;
}
const commandAvailable = (name: string): boolean => (process.env.PATH ?? '').split(delimiter).some(dir => {
  try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
});
export function consoleProviders(): ConsoleProvider[] {
  const configured: unknown = loadConfig().leadModels;
  if (configured !== undefined && !Array.isArray(configured)) throw new ConsoleError('leadModels must be an array of model@effort strings.');
  const leads = (configured ?? []).map((spec: unknown, index: number) => {
    const where = `leadModels[${index}]`;
    if (typeof spec !== 'string' || !spec.trim() || /\s|\0/.test(spec.trim()) || spec.split('@').length > 2) {
      throw new ConsoleError(`${where} must be a native model followed by @effort.`);
    }
    let parsed: ReturnType<typeof parseModel>;
    try { parsed = parseModel(spec); }
    catch (error) { throw new ConsoleError(`${where}: ${(error as Error).message}`); }
    if (parsed.host !== 'codex' && parsed.host !== 'claude') throw new ConsoleError(`${where} must use Codex or Claude Code.`);
    if (parsed.effort === undefined) throw new ConsoleError(`${where} requires an explicit @effort for lead model switching.`);
    if (parsed.model.length > 160) throw new ConsoleError(`${where} model must contain at most 160 characters.`);
    return { ...parsed, effort: parsed.effort };
  });
  let roster: ReturnType<typeof loadRoster>;
  try { roster = loadRoster(); } catch { roster = undefined; }
  return (['codex', 'claude'] as const).map(host => {
    const models = new Map<string, { id: string; label: string; efforts: string[] }>();
    for (const entry of roster ?? []) {
      if (entry.enabled === false || !entry.model.startsWith(`${host}/`)) continue;
      const id = entry.model.slice(host.length + 1);
      const item = models.get(id) ?? { id, label: id, efforts: [] };
      if (!item.efforts.includes(entry.effort)) item.efforts.push(entry.effort);
      models.set(id, item);
    }
    for (const entry of leads) {
      if (entry.host !== host) continue;
      const item = models.get(entry.model) ?? { id: entry.model, label: entry.model, efforts: [] };
      if (!item.efforts.includes(entry.effort)) item.efforts.push(entry.effort);
      models.set(entry.model, item);
    }
    const available = commandAvailable(host);
    return { id: host, label: host === 'codex' ? 'Codex' : 'Claude Code', available, ...(!available ? { reason: `${host} CLI is not installed on PATH.` } : {}), models: [...models.values()], capabilities: hostCapabilities(host) };
  });
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleError('Expected a JSON object.');
  return value as Record<string, unknown>;
};
const only = (v: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(v).some(k => !keys.includes(k))) throw new ConsoleError('Unknown input field.');
};
const text = (value: unknown, label: string, max = 24_000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ConsoleError(`${label} must contain 1–${max} characters.`);
  return value;
};
const requestId = (value: unknown): string => {
  if (typeof value !== 'string' || !SAFE_CONSOLE_ID.test(value)) throw new ConsoleError('requestId must be a stable safe identifier (1–128 characters).');
  return value;
};
function launchInput(value: unknown, providers: ConsoleProvider[], prior?: ConsoleLaunch): ConsoleLaunch {
  const v = object(value); only(v, ['requestId', 'title', 'cwd', 'mode', 'host', 'model', 'effort', 'access', 'prompt', 'mcpServers']);
  const id = requestId(v.requestId); const prompt = text(v.prompt, 'Prompt');
  if (v.host !== 'codex' && v.host !== 'claude') throw new ConsoleError('Choose Codex or Claude Code.');
  if (v.mode !== 'cos' && v.mode !== 'advisor') throw new ConsoleError('Choose CoS or advisor.');
  const access = v.access ?? 'default';
  if (access !== 'default' && access !== 'workspace' && access !== 'full') throw new ConsoleError('Invalid access setting.');
  const cwd = text(v.cwd, 'Project directory', 4096);
  if (!isAbsolute(cwd)) throw new ConsoleError('Project directory must be absolute.');
  let project: string;
  try { project = realpathSync(cwd); accessSync(project, constants.R_OK | constants.X_OK); }
  catch { if (prior?.cwd === cwd) project = cwd; else throw new ConsoleError('Project directory is not available.'); }
  if (!prior && !directoryExists(project)) throw new ConsoleError('Project directory must be a directory.');
  // A real directory, not a command or arbitrary provider argument.
  const provider = providers.find(p => p.id === v.host);
  if (!prior && !provider?.available) throw new ConsoleError(provider?.reason ?? 'Provider is unavailable.', 409, 'PROVIDER_UNAVAILABLE');
  if (!prior && v.host === 'claude' && access === 'workspace') throw new ConsoleError('Claude CLI cannot enforce general workspace filesystem confinement. Choose host default or explicit full access.', 409, 'UNSUPPORTED_ACCESS');
  let model: string | undefined;
  if (v.model !== undefined) {
    model = text(v.model, 'Model', 160);
    if (!prior && !provider!.models.some(m => m.id === model)) throw new ConsoleError('Choose a configured provider model.');
  }
  let effort: string | undefined;
  if (v.effort !== undefined) {
    effort = text(v.effort, 'Effort', 16);
    if (!prior && (!model || !provider!.models.find(m => m.id === model)?.efforts?.includes(effort))) throw new ConsoleError('Choose a supported effort for the selected model.');
  }
  return { requestId: id, cwd: project, host: v.host, mode: v.mode, prompt, access,
    ...(v.title !== undefined ? { title: text(v.title, 'Title', 160) } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    ...(v.mcpServers === undefined ? {} : { mcpServers: validateMcpServers(v.mcpServers) }) };
}
function messageInput(value: unknown): ConsoleMessage {
  const v = object(value); only(v, ['requestId', 'text', 'interrupt']);
  if (v.interrupt !== undefined && typeof v.interrupt !== 'boolean') throw new ConsoleError('interrupt must be a boolean.');
  return { requestId: requestId(v.requestId), text: text(v.text, 'Message'), ...(v.interrupt !== undefined ? { interrupt: v.interrupt as boolean } : {}) };
}
function actionInput(value: unknown): ConsoleAction {
  const v = object(value); only(v, ['requestId', 'action', 'revision']);
  if (!['interrupt', 'resume', 'suspend', 'close'].includes(String(v.action)) || typeof v.action !== 'string') throw new ConsoleError('Invalid action.');
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0) throw new ConsoleError('Action requires the current session revision.');
  return { requestId: requestId(v.requestId), action: v.action as ConsoleAction['action'], revision: v.revision as number };
}
function configurationInput(value: unknown): ConsoleConfiguration {
  const v = object(value); only(v, ['requestId', 'revision', 'host', 'model', 'effort', 'mode']);
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0) throw new ConsoleError('Configuration requires the current session revision.');
  if (v.host !== undefined && v.host !== 'codex' && v.host !== 'claude') throw new ConsoleError('Choose Codex or Claude Code.');
  if (v.mode !== undefined && v.mode !== 'cos' && v.mode !== 'advisor') throw new ConsoleError('Choose CoS or advisor.');
  return { requestId: requestId(v.requestId), revision: Number(v.revision), ...(v.host === undefined ? {} : { host: v.host }),
    ...(v.mode === undefined ? {} : { mode: v.mode }), ...(v.model === undefined ? {} : { model: text(v.model, 'Model', 160) }),
    ...(v.effort === undefined ? {} : { effort: text(v.effort, 'Effort', 16) }) };
}
function answerInput(value: unknown): ConsoleAnswer {
  const v = object(value); only(v, ['requestId', 'pendingRequestId', 'option', 'answers']);
  const pendingRequestId = text(v.pendingRequestId, 'Pending request', 256);
  const result: ConsoleAnswer = { requestId: requestId(v.requestId), pendingRequestId };
  if (v.option !== undefined) result.option = text(v.option, 'Option', 128);
  if (v.answers !== undefined) {
    const raw = object(v.answers); const answers: Record<string, string | string[]> = Object.create(null);
    if (Object.keys(raw).length > 20) throw new ConsoleError('Too many question answers.');
    for (const [key, value] of Object.entries(raw)) {
      if (key.length > 256) throw new ConsoleError('Invalid question ID.');
      answers[key] = Array.isArray(value) ? value.slice(0, 20).map(v => text(v, 'Answer', 4096)) : text(value, 'Answer', 4096);
    }
    result.answers = answers;
  }
  if (!!result.option === !!result.answers) throw new ConsoleError('Provide one approval option or question answers.');
  return result;
}
export interface ConsoleControllerOptions {
  root?: string;
  providers?: () => ConsoleProvider[];
  /** Test seam: injected launcher may run a fixture supervisor, never browser-selectable. */
  startSupervisor?: (id: string) => Promise<void>;
  receiptWaitMs?: number;
}
export class ConsoleController {
  readonly root: string;
  readonly token = randomBytes(32).toString('hex');
  private providers: () => ConsoleProvider[];
  private startSupervisor: (id: string) => Promise<void>;
  private receiptWaitMs: number;
  constructor(options: ConsoleControllerOptions = {}) {
    this.root = options.root ?? home(); this.providers = options.providers ?? consoleProviders;
    this.startSupervisor = options.startSupervisor ?? (id => this.launchSupervisor(id));
    this.receiptWaitMs = options.receiptWaitMs ?? 2_000;
  }
  bootstrap(): ConsoleBootstrap {
    const sessions = consoleSessions(this.root);
    const projects = [...new Set([...sessions.map(s => s.cwd), process.cwd()])].slice(0, 30).map(cwd => ({ cwd, name: basename(cwd) || cwd }));
    return { token: this.token, providers: this.providers(), projects, sessions };
  }
  detail(id: string, before?: string) { return readMeta(id, this.root)?.child ? undefined : consoleDetail(id, before, this.root); }
  session(id: string) { this.requireRoot(id); return publicSession(id, this.root); }
  requests(id: string) { this.requireRoot(id); return consoleRequests(id, this.root); }
  childRequests(id: string, runId: string) { const run = this.requireChild(id, runId); return run.state === 'stopped' ? [] : consoleRequests(run.console!.sessionId, this.root); }
  team(id: string) { return consoleTeam(id, this.root); }
  childDetail(id: string, run: string, before?: string) { return consoleChildDetail(id, run, before, this.root); }
  events(id: string, cursor?: string, limit?: number) { this.requireRoot(id); return consoleEvents(id, cursor, limit, this.root); }
  childEvents(id: string, runId: string, cursor?: string, limit?: number) {
    const run = this.requireChild(id, runId); return consoleEvents(run.console!.sessionId, cursor, limit, this.root);
  }
  update(id?: string, run?: string): ConsoleUpdate { return { sessions: consoleSessions(this.root), detail: id ? this.detail(id) ?? null : null,
    team: id ? this.team(id) ?? null : null, childDetail: id && run ? this.childDetail(id, run) ?? null : null }; }
  /** Called only after crew spawn reserves a routed child and its owned metadata. */
  async launchChild(run: RunMeta): Promise<void> {
    const meta = ownedChild(run, this.root);
    if (!meta || run.state === 'stopped') throw new ConsoleError('Managed child was retired before launch.', 409, 'SESSION_RETIRED');
    acceptIntent(run.console!.sessionId, { kind: 'launch', payload: meta.launch }, this.root);
    await this.startSupervisor(run.console!.sessionId);
  }
  async launch(value: unknown): Promise<ConsoleMutation> {
    const incomingId = requestId(object(value).requestId);
    const id = `s-${createHash('sha256').update(incomingId).digest('hex').slice(0, 24)}`;
    const prior = readMeta(id, this.root);
    const launch = launchInput(value, prior ? [] : this.providers(), prior?.launch);
    return await withLockAsync(`console-launch-${createHash('sha256').update(this.root + id).digest('hex')}`, async () => {
      const intent: ConsoleIntent = { kind: 'launch', payload: launch };
      if (readMeta(id, this.root)) {
        const existing = readReceipt(id, launch.requestId, this.root);
        if (!existing || existing.hash !== intentHash(intent)) throw new ConsoleError('This launch ID already identifies another launch.', 409, 'REQUEST_ID_CONFLICT');
        return this.receiptMutation(id, launch.requestId);
      }
      const at = new Date().toISOString();
      const instructions = rootInstructions(launch.mode);
      const meta: ConsoleMeta = { launch, instructions, argsHash: consoleArgsHash(loadConfig().args[launch.host]) };
      const view: ConsoleView = { session: { id, title: launch.title ?? `${launch.host === 'codex' ? 'Codex' : 'Claude'} ${launch.mode}`, cwd: launch.cwd, mode: launch.mode, host: launch.host,
        access: launch.access ?? 'default', state: 'starting', revision: 0, createdAt: at, updatedAt: at, rootNodeId: `console-${id}`, capabilities: hostCapabilities(launch.host), pendingRequests: 0,
        ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}) }, events: [], requests: [], commands: {}, sequence: 0 };
      mkdirSync(sessionDir(id, this.root), { recursive: true, mode: 0o700 });
      writeJson(metaPath(id, this.root), meta); writeView(id, view, this.root);
      acceptIntent(id, intent, this.root);
      try { await this.startSupervisor(id); }
      catch {
        const receipt = readReceipt(id, launch.requestId, this.root)!;
        receipt.phase = 'complete'; receipt.command = { requestId: launch.requestId, state: 'failed', error: 'Owned supervisor could not start.' };
        writeJson(receiptPath(id, launch.requestId, this.root), receipt);
        view.session.state = 'failed'; view.session.error = receipt.command.error!; writeView(id, view, this.root);
      }
      return this.receiptMutation(id, launch.requestId);
    });
  }
  private requireRoot(id: string): void {
    const meta = readMeta(id, this.root);
    if (!meta || meta.child) throw new ConsoleError('Managed root is unavailable.', 404, 'SESSION_NOT_FOUND');
  }
  async message(id: string, value: unknown): Promise<ConsoleMutation> { this.requireRoot(id); return this.mutate(id, { kind: 'message', payload: messageInput(value) }); }
  async action(id: string, value: unknown): Promise<ConsoleMutation> { this.requireRoot(id); return this.mutate(id, { kind: 'action', payload: actionInput(value) }); }
  async answer(id: string, value: unknown): Promise<ConsoleMutation> { this.requireRoot(id); return this.mutate(id, { kind: 'answer', payload: answerInput(value) }); }
  async configure(id: string, value: unknown): Promise<ConsoleMutation> {
    this.requireRoot(id);
    const payload = configurationInput(value); const intent = { kind: 'configure' as const, payload };
    if (readReceipt(id, payload.requestId, this.root)) {
      acceptIntent(id, intent, this.root); return this.receiptMutation(id, payload.requestId);
    }
    const meta = readMeta(id, this.root)!;
    if (payload.host !== undefined && payload.host !== meta.launch.host) throw new ConsoleError('Keep the current native provider in this chat. Start another chat to switch between Codex and Claude.', 409, 'UNSUPPORTED_HOST_CHANGE');
    const next = configuredLaunch(meta.launch, payload);
    if (payload.model !== undefined || payload.effort !== undefined) {
      const model = this.providers().find(provider => provider.id === next.host)?.models.find(model => model.id === next.model);
      if (!model) throw new ConsoleError('Choose a configured provider model.');
      if (next.effort && !model.efforts?.includes(next.effort)) throw new ConsoleError('Choose a supported effort for the selected model.');
    }
    const offline = withLock(`console-owner-${id}`, () => {
      if (readReceipt(id, payload.requestId, this.root)) return;
      const current = readMeta(id, this.root)!; const session = publicSession(id, this.root)!;
      if (current.retiring || session.state === 'closed') throw new ConsoleError('Session is deliberately closed.', 409, 'SESSION_CLOSED');
      const owner = readJson<{ pid: number }>(join(sessionDir(id, this.root), 'owner.json'));
      if (supervisorAlive(current) || (current.pid && processExists(current.pid)) || (owner?.pid && processExists(owner.pid))) return;
      if (!current.identity) throw new ConsoleError('No recorded provider identity is available.', 409, 'IDENTITY_UNAVAILABLE');
      if (payload.revision !== session.revision) throw new ConsoleError('Session changed. Refresh before applying configuration.', 409, 'STALE_REVISION');
      const receipt = acceptIntent(id, intent, this.root); const view = readView(id, this.root)!;
      receipt.phase = 'attempted'; writeJson(receiptPath(id, payload.requestId, this.root), receipt);
      const launch = configuredLaunch(current.launch, payload);
      const instructions = rootInstructions(launch.mode);
      writeJson(metaPath(id, this.root), { ...current, launch, instructions,
        ...(instructions !== current.instructions ? { instructionsRefresh: true } : {}) });
      Object.assign(view.session, { mode: launch.mode, model: launch.model, effort: launch.effort, state: 'disconnected', revision: session.revision + 1, updatedAt: new Date().toISOString() });
      receipt.phase = 'complete'; receipt.command = { requestId: payload.requestId, state: 'delivered' };
      view.commands[payload.requestId] = receipt.command;
      appendConsoleChanges(id, [{ kind: 'session', session: view.session }, { kind: 'command', command: receipt.command }], this.root); writeView(id, view, this.root);
      writeJson(receiptPath(id, payload.requestId, this.root), receipt);
      return { session: view.session, command: receipt.command };
    });
    return offline ?? this.mutate(id, intent);
  }
  private requireChild(id: string, runId: string): RunMeta {
    this.requireRoot(id);
    const run = childRun(runId, this.root);
    if (!run || !belongsToRoot(run, id, this.root)) throw new ConsoleError('Child does not belong to this root.', 404, 'CHILD_NOT_FOUND');
    if (!ownedChild(run, this.root)) throw new ConsoleError('Child has no console-owned native pipe. Use its native host.', 409, 'CHILD_UNMANAGED');
    return run;
  }
  async childAction(id: string, runId: string, value: unknown): Promise<ConsoleChildMutation> {
    const run = this.requireChild(id, runId);
    const v = object(value);
    if (!['interrupt', 'resume', 'stop'].includes(String(v.action))) throw new ConsoleError('Invalid child action.');
    const action = actionInput({ ...v, action: v.action === 'stop' ? 'close' : v.action });
    const result = await this.mutate(run.console!.sessionId, { kind: 'action', payload: action });
    return { child: this.childDetail(id, runId)!.child, command: result.command };
  }
  async childAnswer(id: string, runId: string, value: unknown): Promise<ConsoleChildMutation> {
    const run = this.requireChild(id, runId);
    const result = await this.mutate(run.console!.sessionId, { kind: 'answer', payload: answerInput(value) });
    return { child: this.childDetail(id, runId)!.child, command: result.command };
  }
  /** A reconnecting client may rotate its MCP endpoints/credentials only after all
   * owned pipes have been released. Provider identities and packets remain unchanged. */
  refreshMcp(id: string, servers: unknown): void {
    this.requireRoot(id);
    const mcpServers = validateMcpServers(servers);
    const targets = [id, ...(this.team(id)?.children ?? []).filter(child => child.managed && child.runState !== 'stopped').map(child => this.requireChild(id, child.runId).console!.sessionId)].sort();
    const refresh = (): void => {
      const metas = targets.map(target => {
        const meta = readMeta(target, this.root); const session = publicSession(target, this.root);
        if (!meta || !meta.identity || meta.retiring || meta.pid || meta.epoch || session?.state !== 'disconnected') throw new ConsoleError('Suspend the whole owned session before refreshing MCP configuration.', 409, 'SESSION_ACTIVE');
        return [target, meta] as const;
      });
      for (const [target, meta] of metas) writeJson(metaPath(target, this.root), { ...meta, launch: { ...meta.launch, mcpServers } });
    };
    const lock = (at: number): void => { if (at === targets.length) refresh(); else withLock(`console-owner-${targets[at]}`, () => lock(at + 1)); };
    lock(0);
  }
  /** Release owned provider processes after a client disconnect without retiring packets.
   * Suspend the root first so it cannot create new descendants during cleanup. */
  async suspend(id: string): Promise<void> {
    this.requireRoot(id);
    const release = async (target: string): Promise<void> => {
      const session = publicSession(target, this.root);
      if (!session || session.state === 'closed') return;
      const result = await this.mutate(target, { kind: 'action', payload: { requestId: `suspend-${randomBytes(16).toString('hex')}`, action: 'suspend', revision: session.revision } });
      const deadline = Date.now() + 15_000;
      let receipt = readReceipt(target, result.command.requestId, this.root);
      while (receipt?.phase !== 'complete' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25)); receipt = readReceipt(target, result.command.requestId, this.root);
      }
      if (receipt?.command.state !== 'delivered') throw new ConsoleError('Owned session suspension was not confirmed.', 409, 'SUSPEND_FAILED');
    };
    const failures: string[] = [];
    try { await release(id); } catch (error) { failures.push(error instanceof Error ? error.message : 'Root suspension failed.'); }
    for (const child of this.team(id)?.children ?? []) {
      if (!child.managed || child.runState === 'stopped') continue;
      const run = this.requireChild(id, child.runId);
      try { await release(run.console!.sessionId); } catch (error) { failures.push(error instanceof Error ? error.message : 'Child suspension failed.'); }
    }
    if (failures.length) throw new ConsoleError(failures.join('\n'), 409, 'SUSPEND_FAILED');
  }
  private async mutate(id: string, intent: Exclude<ConsoleIntent, { kind: 'launch' }>): Promise<ConsoleMutation> {
    const session = publicSession(id, this.root);
    if (!session) throw new ConsoleError('Managed session is unavailable.', 404, 'SESSION_NOT_FOUND');
    const prior = readReceipt(id, intent.payload.requestId, this.root);
    if (prior) { acceptIntent(id, intent, this.root); return this.receiptMutation(id, intent.payload.requestId); }
    if (session.state === 'closed') throw new ConsoleError('Session is deliberately closed.', 409, 'SESSION_CLOSED');
    if (readMeta(id, this.root)?.retiring && !(intent.kind === 'action' && intent.payload.action === 'close')) throw new ConsoleError('The team is being retired. Retry Close to finish retirement.', 409, 'SESSION_RETIRED');
    if (intent.kind === 'action') {
      if (intent.payload.revision !== session.revision) throw new ConsoleError('Session changed. Refresh before applying this action.', 409, 'STALE_REVISION');
      if (intent.payload.action === 'resume') {
        if (!['idle', 'interrupted', 'disconnected', 'failed'].includes(session.state)) throw new ConsoleError('Interrupt the active session before resuming.', 409, 'UNSUPPORTED_ACTION');
        if (!readMeta(id, this.root)?.identity?.sessionId) throw new ConsoleError('No recorded provider identity is available. Start a new session.', 409, 'IDENTITY_UNAVAILABLE');
      }
    }
    if (intent.kind === 'configure' && intent.payload.revision !== session.revision) throw new ConsoleError('Session changed. Refresh before applying configuration.', 409, 'STALE_REVISION');
    const meta = readMeta(id, this.root);
    const restart = intent.kind === 'action' && intent.payload.action === 'resume' && !supervisorAlive(meta);
    // Closing a dead supervisor still retires the root; a short-lived supervisor handles that intent.
    const retire = intent.kind === 'action' && ['close', 'suspend'].includes(intent.payload.action) && !supervisorAlive(meta);
    if (!restart && !retire && !supervisorAlive(meta)) throw new ConsoleError('Supervisor is disconnected. Resume the recorded session explicitly.', 409, 'SUPERVISOR_UNAVAILABLE');
    if (intent.kind === 'answer' && !consoleRequests(id, this.root).some(r => r.id === intent.payload.pendingRequestId)) throw new ConsoleError('Approval or question is no longer pending.', 409, 'STALE_REQUEST');
    acceptIntent(id, intent, this.root);
    if (restart || retire) await this.startSupervisor(id);
    return this.receiptMutation(id, intent.payload.requestId);
  }
  private async receiptMutation(id: string, requestId: string): Promise<ConsoleMutation> {
    const deadline = Date.now() + this.receiptWaitMs;
    let receipt = readReceipt(id, requestId, this.root);
    while (receipt?.phase !== 'complete' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25)); receipt = readReceipt(id, requestId, this.root);
    }
    if (receipt?.error) throw new ConsoleError(receipt.error.message, receipt.error.status, receipt.error.code);
    const session = publicSession(id, this.root);
    if (!session || !receipt) throw new ConsoleError('Durable receipt is unavailable.', 500, 'STATE_UNAVAILABLE');
    return { session, command: receipt.command };
  }
  private async launchSupervisor(id: string): Promise<void> {
    const log = join(sessionDir(id, this.root), 'supervisor.log');
    const fd = openSync(log, 'a', 0o600);
    const env = { ...rootEnv(), CREW_HOME: this.root };
    const executable = fileURLToPath(new URL('./console-supervisor.ts', import.meta.url));
    try {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', executable, sessionDir(id, this.root)], { env, cwd: dirname(executable), detached: true, stdio: ['ignore', fd, fd] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { closeSync(fd); }
  }
}
