import { execFileSync } from 'node:child_process';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const inHerdr = (env = process.env): boolean => env.HERDR_ENV === '1' && Boolean(env.HERDR_PANE_ID);

/** herdr panes export their binary; hooks started by GUI apps may lack ~/.local/bin on PATH. */
export const herdrBin = (): string => process.env.HERDR_BIN_PATH || 'herdr';

type Result = { ok: true; json: unknown } | { ok: false; error: string };

/** `session` pins the call to one herdr session; without it herdr uses the caller's environment. */
export function herdr(args: string[], timeoutMs = 15_000, session?: string): Result {
  try {
    const out = execFileSync(herdrBin(), session ? ['--session', session, ...args] : args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
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

function split(target: string, dir: 'right' | 'down', cwd: string, env: Record<string, string>, session?: string): Result & { pane?: string } {
  const args = ['pane', 'split', target, '--direction', dir, '--cwd', cwd, '--no-focus'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  const result = herdr(args, 15_000, session);
  if (!result.ok) return result;
  const pane = find(result.json, 'pane_id');
  return pane ? { ...result, pane } : { ok: false, error: 'herdr pane split returned no pane_id' };
}

/**
 * Stack-first layout (as pi-detach did): split away from the caller by subdividing its newest
 * surviving child, shaped by that pane's geometry. The caller is split only when no child pane
 * is left, and then to the right, so the root keeps its column. The child inherits `env`.
 */
export function splitAway(caller: string, stack: readonly string[], cwd: string, env: Record<string, string>, session?: string): string {
  let lastError = 'pane split refused';
  for (const target of stack) {
    if (target === caller) continue;
    const attempt = split(target, direction(target, session), cwd, env, session);
    if (attempt.ok && attempt.pane) return attempt.pane;
    if (!attempt.ok) lastError = attempt.error;
  }
  const attempt = split(caller, stack.length ? direction(caller, session) : 'right', cwd, env, session);
  if (attempt.ok && attempt.pane) return attempt.pane;
  throw new Error(`herdr pane split failed: ${attempt.ok ? lastError : attempt.error}`);
}

/**
 * Start an agent whose first prompt rides in argv. herdr's readiness check waits for an idle agent,
 * which a working one never is, so give it a few seconds and then only require that herdr sees it.
 */
export function startAgent(name: string, kind: string, pane: string, argv: string[], session?: string): void {
  const start = (): Result => herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '8000', '--', ...argv], 15_000, session);
  let started = start();
  // A fresh split's shell may still be loading its rc files; herdr refuses (nothing typed) until it's up.
  for (let waited = 0; !started.ok && started.error.includes('agent_pane_busy') && waited < 10_000; waited += 500) {
    execFileSync('sleep', ['0.5']);
    started = start();
  }
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

/** Border label herdr shows for a pane, e.g. `builder · ts-ui-api`. Best effort. */
export function labelPane(pane: string, label: string, session?: string): boolean {
  return herdr(['pane', 'rename', pane, label], 5_000, session).ok;
}

export function closePane(pane: string, session?: string): void {
  herdr(['pane', 'close', pane], 5_000, session);
}
