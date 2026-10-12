import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readRun, runDir, updateRun, writeJson } from './store.ts';
import type { Host, RunMeta } from './types.ts';

const BRIDGE_KEYS = ['T3_ACP_MCP_NODE', 'T3_ACP_MCP_ENTRYPOINT', 'T3_ACP_MCP_ENDPOINT', 'T3_ACP_MCP_AUTHORIZATION'] as const;
type Bridge = Record<typeof BRIDGE_KEYS[number], string> & { T3_CREW_THREAD_ID?: string };
export type T3State = 'starting' | 'running' | 'waiting' | 'idle' | 'interrupted' | 'failed' | 'stopped';
export interface T3Worker {
  runId: string;
  threadId: string;
  taskId: string;
  state: T3State;
  nativeSessionId?: string;
}
type Action = 'start' | 'status' | 'resume' | 'stop';

function bridgeFrom(env: NodeJS.ProcessEnv): Bridge | undefined {
  if (['T3_ACP_MCP_NODE', 'T3_ACP_MCP_ENDPOINT', 'T3_ACP_MCP_AUTHORIZATION'].some(key => typeof env[key] !== 'string' || !env[key])) return undefined;
  if (env.T3_ACP_MCP_ENTRYPOINT !== undefined && typeof env.T3_ACP_MCP_ENTRYPOINT !== 'string') return undefined;
  return { ...Object.fromEntries(BRIDGE_KEYS.map(key => [key, env[key] ?? ''])),
    ...(typeof env.T3_CREW_THREAD_ID === 'string' && env.T3_CREW_THREAD_ID ? { T3_CREW_THREAD_ID: env.T3_CREW_THREAD_ID } : {}) } as Bridge;
}

/** A managed root must never silently route work to a headless fallback. */
export function nativeT3Bridge(host: Host): Bridge | undefined {
  if (process.env.CREWCODE_NATIVE_CREW !== '1') return undefined;
  const bridge = bridgeFrom(process.env);
  if (!bridge) throw new Error('crew: native T3 worker bridge is unavailable; start this run from a connected CrewCode session');
  if (host === 'opencode') throw new Error('crew: native T3 workers support Codex and Claude only; choose a supported model');
  return bridge;
}

const bridgePath = (id: string): string => join(runDir(id), 't3-bridge.json');

/** Credentials belong to the owning bridge, never to public run metadata or argv. */
export function prepareT3(run: RunMeta, bridge: Bridge): void {
  writeJson(bridgePath(run.id), bridge); // atomic replacement always creates mode 0600
  updateRun(run.id, current => ({ ...current, t3Request: { action: 'start', requestId: randomUUID() } }));
}

function ownerBridge(run: RunMeta): { preferred: Bridge; stored: Bridge } {
  let stored: Bridge | undefined;
  try { stored = readJson<Bridge>(bridgePath(run.id)); }
  catch { throw new Error(`crew: ${run.name}'s private T3 bridge ownership is unreadable`); }
  if (!stored || !bridgeFrom(stored)) throw new Error(`crew: ${run.name} has no private T3 bridge ownership; stop or resume it in CrewCode`);
  const current = bridgeFrom(process.env);
  // Another root's token on the same server is not this run's ownership context.
  const matching = current?.T3_ACP_MCP_ENDPOINT === stored.T3_ACP_MCP_ENDPOINT
    && (stored.T3_CREW_THREAD_ID ? current.T3_CREW_THREAD_ID === stored.T3_CREW_THREAD_ID
      : current.T3_ACP_MCP_AUTHORIZATION === stored.T3_ACP_MCP_AUTHORIZATION);
  return { preferred: matching ? current : stored, stored };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(text: string, run: RunMeta): T3Worker {
  let value: unknown;
  try {
    value = JSON.parse(text);
    const wrapper = record(value);
    if (wrapper?.isError) throw new Error('MCP rejected call');
    if (wrapper?.structuredContent) value = wrapper.structuredContent;
    else if (Array.isArray(wrapper?.content)) {
      const content = wrapper.content.find(item => record(item)?.type === 'text');
      value = JSON.parse(record(content)?.text as string);
    }
  } catch { throw new Error(`crew: T3 rejected ${run.name}'s worker call or returned an invalid response`); }
  const result = record(value);
  const states: T3State[] = ['starting', 'running', 'waiting', 'idle', 'interrupted', 'failed', 'stopped'];
  if (result?.runId !== run.id || typeof result.threadId !== 'string' || !result.threadId
    || typeof result.taskId !== 'string' || !result.taskId || !states.includes(result.state as T3State)
    || (result.nativeSessionId !== undefined && (typeof result.nativeSessionId !== 'string' || !result.nativeSessionId))) {
    throw new Error(`crew: invalid T3 worker identity/state for ${run.name}`);
  }
  if (run.t3 && (run.t3.threadId !== result.threadId || run.t3.taskId !== result.taskId)) {
    throw new Error(`crew: T3 worker ownership changed for ${run.name}; call refused`);
  }
  return { runId: result.runId as string, threadId: result.threadId, taskId: result.taskId,
    state: result.state as T3State, ...(typeof result.nativeSessionId === 'string' ? { nativeSessionId: result.nativeSessionId } : {}) };
}

/** The authenticated bridge resolves all prompts, routing and ancestry from Crew's files. */
export async function t3Worker(run: RunMeta, action: Action, requestId?: string): Promise<T3Worker> {
  if (run.launcher !== 't3') throw new Error(`crew: ${run.name} is not a native T3 worker`);
  if ((action === 'start' || action === 'resume') && readRun(run.id)?.state === 'stopped') {
    throw new Error(`crew: ${run.name} is stopped; spawn a new run for new work`);
  }
  const { preferred, stored } = ownerBridge(run);
  const call = (bridge: Bridge): Promise<string> => {
    const args = [...(bridge.T3_ACP_MCP_ENTRYPOINT ? [bridge.T3_ACP_MCP_ENTRYPOINT] : []),
      'acp-mcp-call', 'crew_worker', JSON.stringify({ action, runId: run.id, ...(requestId ? { requestId } : {}) })];
    return new Promise((resolve, reject) => {
      execFile(bridge.T3_ACP_MCP_NODE, args, {
        cwd: run.cwd, env: { ...process.env, ...bridge, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8', timeout: action === 'stop' ? 60_000 : 30_000, maxBuffer: 256 * 1024,
      }, (error, stdout) => {
        // Child errors include argv/stdout/stderr. Do not echo arbitrary bridge output or credentials.
        if (error) reject(new Error(`crew: T3 ${action} failed for ${run.name}; reconnect CrewCode and retry (no headless fallback)`));
        else resolve(stdout);
      });
    });
  };
  let bridge = preferred;
  let text: string;
  try { text = await call(bridge); }
  catch (error) {
    if (JSON.stringify(preferred) === JSON.stringify(stored)) throw error;
    // A watcher may still carry a revoked token from before its owner reconnected.
    bridge = stored;
    text = await call(bridge);
  }
  const result = decode(text, readRun(run.id) ?? run);
  updateRun(run.id, current => {
    if (current.t3 && (current.t3.threadId !== result.threadId || current.t3.taskId !== result.taskId)) {
      throw new Error(`crew: T3 worker ownership changed for ${run.name}; call refused`);
    }
    if (result.nativeSessionId && current.sessionId && result.nativeSessionId !== current.sessionId
      && (action === 'status' || action === 'stop' || current.sessionId !== run.sessionId)) {
      throw new Error(`crew: T3 native session ownership changed for ${run.name}; call refused`);
    }
    // Only authenticated success refreshes credentials. A late response cannot resurrect retired secrets.
    if (!current.t3Stopped) writeJson(bridgePath(run.id), bridge);
    return { ...current, t3: { threadId: result.threadId, taskId: result.taskId },
      ...(result.nativeSessionId ? { sessionId: result.nativeSessionId,
        ...(current.route.host === 'codex' ? { threadId: result.nativeSessionId } : {}) } : {}),
    };
  });
  return result;
}

/** Keep credentials for failed stops and retained idle workers; discard them after confirmed retirement. */
export function retireT3Bridge(id: string): void {
  updateRun(id, current => ({ ...current, state: 'stopped', t3Stopped: true }));
  try { unlinkSync(bridgePath(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Commit a successful request without erasing a concurrent stop, hook or settlement. */
export function finishT3Request(id: string, requestId: string): void {
  updateRun(id, current => {
    if (current.t3Request?.requestId !== requestId) return undefined;
    const { t3Request, ...rest } = current;
    return { ...rest, ...(t3Request.mailId && current.resumedMail === t3Request.priorMail ? { resumedMail: t3Request.mailId } : {}) };
  });
}
