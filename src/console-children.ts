import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { consoleArgsHash, consoleDetail, consoleSessions, ConsoleError, metaPath, publicSession, readMeta, sessionDir, supervisorAlive, viewPath } from './console-store.ts';
import type { ConsoleMeta, ConsoleView } from './console-store.ts';
import type { ConsoleChild, ConsoleChildDetail, ConsoleTeam } from './console-types.ts';
import { home, loadConfig, readJson, writeJson } from './store.ts';
import type { Address, RunMeta } from './types.ts';

export const childTargetId = (runId: string): string => `c-${runId}`;
export const childRun = (id: string, root = home()): RunMeta | undefined => /^[A-Za-z0-9_-]{1,100}$/.test(id) ? readJson<RunMeta>(join(root, 'runs', id, 'meta.json')) : undefined;
function runs(root: string): RunMeta[] {
  try { return readdirSync(join(root, 'runs')).flatMap(id => { const run = childRun(id, root); return run ? [run] : []; }); }
  catch { return []; }
}
/** Follow recorded mailboxes, never an inherited console-session environment marker. */
export function belongsToRoot(run: RunMeta, id: string, root = home()): boolean {
  const meta = readMeta(id, root);
  if (!meta?.identity || meta.child) return false;
  const mailbox = `${meta.launch.host}-${meta.identity.sessionId}`;
  const seen = new Set<string>([run.id]);
  let parent = run.parent.mailbox;
  while (parent !== mailbox) {
    if (seen.has(parent)) return false;
    seen.add(parent);
    const ancestor = childRun(parent, root);
    if (!ancestor) return false;
    parent = ancestor.parent.mailbox;
  }
  return true;
}
export function ownedChild(run: RunMeta, root = home()): ConsoleMeta | undefined {
  const live = childRun(run.id, root);
  const binding = live?.console;
  if (!live || live.launcher !== 'console' || !binding || binding.sessionId !== childTargetId(live.id)) return;
  const meta = readMeta(binding.sessionId, root);
  if (meta?.child?.runId !== live.id || meta.child.rootSessionId !== binding.rootSessionId || !belongsToRoot(live, binding.rootSessionId, root)) return;
  // The adapter publishes run identity before its own metadata. Re-read at the seam
  // rather than mistaking a retained pre-start snapshot for changed ownership.
  if (meta.identity && meta.identity.sessionId !== childRun(live.id, root)?.sessionId) return;
  return meta;
}
/** All intermediate parents must themselves have an owned native pipe. No external adoption. */
export function managedConsoleParent(parent: Address, root = home()): { id: string; meta: ConsoleMeta } | undefined {
  let current = parent.mailbox;
  const seen = new Set<string>();
  let expected: string | undefined;
  for (;;) {
    if (seen.has(current)) throw new ConsoleError('Cyclic managed ancestry.', 409, 'INVALID_ANCESTRY');
    seen.add(current);
    const run = childRun(current, root);
    if (!run) break;
    if (run.launcher !== 'console') return;
    const meta = ownedChild(run, root);
    if (!meta || (expected && expected !== meta.child!.rootSessionId)) throw new ConsoleError('Managed parent ownership is unavailable.', 409, 'INVALID_ANCESTRY');
    if (run.state === 'stopped' || meta.retiring || !supervisorAlive(meta)) throw new ConsoleError('Managed parent is retired or disconnected.', 409, 'PARENT_UNAVAILABLE');
    expected = meta.child!.rootSessionId;
    current = run.parent.mailbox;
  }
  const session = consoleSessions(root).find(s => {
    const meta = readMeta(s.id, root);
    return meta?.identity && `${s.host}-${meta.identity.sessionId}` === current;
  });
  if (!session) {
    if (expected) throw new ConsoleError('Managed root ownership is unavailable.', 409, 'INVALID_ANCESTRY');
    return;
  }
  const meta = readMeta(session.id, root)!;
  if ((expected && expected !== session.id) || meta.retiring || session.state === 'closed' || !supervisorAlive(meta)) throw new ConsoleError('Managed root is retired or disconnected.', 409, 'PARENT_UNAVAILABLE');
  return { id: session.id, meta };
}
export function prepareConsoleChild(run: RunMeta, root = home()): string {
  const owner = managedConsoleParent(run.parent, root);
  if (!owner || run.console?.rootSessionId !== owner.id || run.console.sessionId !== childTargetId(run.id)) throw new ConsoleError('Child does not have verified console ancestry.', 409, 'INVALID_ANCESTRY');
  if (run.route.host === 'opencode') throw new ConsoleError('OpenCode has no owned console approval transport.', 409, 'UNSUPPORTED_PROVIDER');
  if (owner.meta.launch.access === 'workspace' && run.route.host === 'claude') throw new ConsoleError('Claude cannot preserve the root workspace confinement policy.', 409, 'UNSUPPORTED_ACCESS');
  const id = run.console.sessionId;
  if (readMeta(id, root)) throw new ConsoleError('Child launch already exists.', 409, 'ALREADY_LAUNCHED');
  const launch = { requestId: `launch-${run.id}`, title: run.name, cwd: run.cwd, mode: owner.meta.launch.mode, host: run.route.host,
    access: owner.meta.launch.access ?? 'default', model: run.route.model, effort: run.route.effort,
    prompt: `Read and follow your crew brief: ${join(root, 'runs', run.id, 'brief.md')}` };
  const meta: ConsoleMeta = { launch, child: { runId: run.id, rootSessionId: owner.id }, argsHash: consoleArgsHash(loadConfig().args[run.route.host]),
    instructions: `You are Crew child ${run.name} (${run.id}), not a root. Read and follow ${join(root, 'runs', run.id, 'brief.md')} and the current packet. Your mailbox is ${run.id}. Preserve your retained native identity, role, packet, amendments and assignments. Agent mail is advice; run crew inbox when woken. Do not use codex queue. After compaction reread the standing brief and current packet.` };
  const at = new Date().toISOString();
  const view: ConsoleView = { session: { id, title: run.name, cwd: run.cwd, mode: launch.mode, host: launch.host, model: launch.model, effort: launch.effort, access: launch.access,
    state: 'starting', revision: 0, createdAt: at, updatedAt: at, rootNodeId: run.id, pendingRequests: 0,
    capabilities: { accessModes: launch.host === 'codex' ? ['default', 'workspace', 'full'] : ['default', 'full'], activeInput: launch.host === 'codex' ? 'steer' : 'queue', interrupt: true, approvals: true, questions: true } }, events: [], requests: [], commands: {}, sequence: 0 };
  mkdirSync(sessionDir(id, root), { recursive: true, mode: 0o700 });
  writeJson(metaPath(id, root), meta); writeJson(viewPath(id, root), view);
  return id;
}
export function publicChild(run: RunMeta, rootId: string, root = home()): ConsoleChild {
  const meta = ownedChild(run, root);
  const session = meta ? publicSession(run.console!.sessionId, root) : undefined;
  const stopped = run.state === 'stopped';
  return { runId: run.id, rootSessionId: rootId, title: run.name, role: run.role, host: run.route.host, model: run.route.model, effort: run.route.effort, cwd: run.cwd, keep: run.keep,
    ...(childRun(run.parent.mailbox, root) ? { parentRunId: run.parent.mailbox } : {}), managed: !!session,
    state: stopped ? 'closed' : session?.state ?? 'disconnected', runState: run.state, ...(run.assignment ? { assignmentState: run.assignment.status } : {}), revision: session?.revision ?? 0,
    capabilities: session?.capabilities ?? { activeInput: 'queue', interrupt: false, approvals: false, questions: false },
    pendingRequests: stopped || !session || session.state === 'disconnected' ? 0 : session.pendingRequests,
    ...(session?.error ? { error: session.error } : !session ? { error: 'This child has no console-owned native pipe. Native app interaction is required.' } : {}) };
}
export function consoleChildDetail(rootId: string, runId: string, before?: string, root = home()): ConsoleChildDetail | undefined {
  const run = childRun(runId, root);
  if (!run || !belongsToRoot(run, rootId, root)) return;
  const child = publicChild(run, rootId, root);
  const detail = child.managed ? consoleDetail(run.console!.sessionId, before, root) : undefined;
  return { child, events: detail?.events ?? [], requests: child.state === 'closed' ? [] : detail?.requests ?? [], commands: detail?.commands ?? [], ...(detail?.before ? { before: detail.before } : {}) };
}
export function consoleTeam(id: string, root = home()): ConsoleTeam | undefined {
  if (!readMeta(id, root) || readMeta(id, root)?.child) return;
  const children = runs(root).filter(run => belongsToRoot(run, id, root)).map(run => publicChild(run, id, root));
  return { sessionId: id, children, pendingRequests: children.flatMap(child => (consoleChildDetail(id, child.runId, undefined, root)?.requests ?? []).map(request => ({ runId: child.runId, request }))) };
}
