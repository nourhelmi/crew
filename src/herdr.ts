import { execFileSync } from 'node:child_process';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const inHerdr = (env = process.env): boolean => env.HERDR_ENV === '1' && Boolean(env.HERDR_PANE_ID);

type Result = { ok: true; json: unknown } | { ok: false; error: string };

/** `session` pins the call to one herdr session; without it herdr uses the caller's environment. */
export function herdr(args: string[], timeoutMs = 15_000, session?: string): Result {
  try {
    const out = execFileSync('herdr', session ? ['--session', session, ...args] : args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    try { return { ok: true, json: JSON.parse(out) }; } catch { return { ok: true, json: out }; }
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    return { ok: false, error: (e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' ') };
  }
}

/** Herdr responses nest ids and states at varying depths; take the first match anywhere. */
export function find(json: unknown, key: string): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const record = json as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === 'string') return direct;
  for (const value of Object.values(record)) {
    const hit = find(value, key);
    if (hit) return hit;
  }
  return undefined;
}

const WIDE_RATIO = 2.5;

function direction(pane: string, session?: string): 'right' | 'down' {
  const layout = herdr(['pane', 'layout', '--pane', pane], 15_000, session);
  if (!layout.ok) return 'right';
  type Rect = { pane_id?: string; rect?: { width?: number; height?: number } };
  const panes = (layout.json as { result?: { layout?: { panes?: Rect[] } } }).result?.layout?.panes ?? [];
  const rect = panes.find(p => p.pane_id === pane)?.rect;
  return rect?.width && rect.height && rect.width < rect.height * WIDE_RATIO ? 'down' : 'right';
}

/** Split the caller's pane without stealing focus; the child inherits `env`. */
export function splitPane(caller: string, cwd: string, env: Record<string, string>, session?: string): string {
  const args = ['pane', 'split', caller, '--direction', direction(caller, session), '--cwd', cwd, '--no-focus'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  const split = herdr(args, 15_000, session);
  if (!split.ok) throw new Error(`herdr pane split failed: ${split.error}`);
  const pane = find(split.json, 'pane_id');
  if (!pane) throw new Error('herdr pane split returned no pane_id');
  return pane;
}

/**
 * Start an agent whose first prompt rides in argv. herdr's readiness check waits for an idle agent,
 * which a working one never is, so give it a few seconds and then only require that herdr sees it.
 */
export function startAgent(name: string, kind: string, pane: string, argv: string[], session?: string): void {
  const started = herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '8000', '--', ...argv], 15_000, session);
  if (started.ok) return;
  for (let waited = 0; waited < 20_000; waited += 1_000) {
    if (agentStatus(pane, session)) return;
    execFileSync('sleep', ['1']);
  }
  throw new Error(`herdr agent start failed: ${started.error}`);
}

export function prompt(target: string, text: string, session?: string): Result {
  return herdr(['agent', 'prompt', target, text], 10_000, session);
}

/** undefined means the agent is gone (exited, released or replaced). */
export function agentStatus(target: string, session?: string): AgentStatus | undefined {
  const got = herdr(['agent', 'get', target], 5_000, session);
  if (!got.ok) return undefined;
  const status = (find(got.json, 'agent_status') ?? find(got.json, 'status'))?.toLowerCase();
  return status === 'idle' || status === 'working' || status === 'blocked' || status === 'done' ? status : 'unknown';
}

export function closePane(pane: string, session?: string): void {
  herdr(['pane', 'close', pane], 5_000, session);
}
