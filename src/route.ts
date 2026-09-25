import { execFile } from 'node:child_process';
import { EFFORTS, type Config, type Effort, type Host, type Role, type Route } from './types.ts';

/** Provider prefixes used by the router catalog and Pi, mapped to the native CLI that runs them. */
const PREFIX = {
  'claude-bridge': 'claude',
  anthropic: 'claude',
  'openai-codex': 'codex',
  openai: 'codex',
} as const satisfies Record<string, Host>;

const BARE: ReadonlyArray<readonly [RegExp, Host]> = [
  [/^(claude-|opus|sonnet|haiku|fable)/, 'claude'],
  [/^(gpt-|o\d|codex-)/, 'codex'],
];

/** Efforts each CLI accepts; anything else is clamped to the nearest supported level. */
const SUPPORTED = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<Host, readonly Effort[]>;

export class RouteError extends Error {}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

export function clampEffort(host: Host, effort: Effort): Effort {
  const allowed: readonly Effort[] = SUPPORTED[host];
  if (allowed.includes(effort)) return effort;
  const rank = EFFORTS.indexOf(effort);
  return rank < EFFORTS.indexOf(allowed[0]!) ? allowed[0]! : allowed[allowed.length - 1]!;
}

/** `openai-codex/gpt-6-sol@xhigh` | `claude-opus-5-5` | `opus@high` -> host, native model id, effort. */
export function parseModel(spec: string): { host: Host; model: string; effort?: Effort } {
  const [path = '', effortText] = spec.trim().split('@');
  const slash = path.indexOf('/');
  let host: Host | undefined;
  let model = path;
  if (slash >= 0) {
    const prefix = path.slice(0, slash);
    host = (PREFIX as Record<string, Host>)[prefix];
    if (!host) throw new RouteError(`not a native model: ${spec} (provider "${prefix}" has no native CLI)`);
    model = path.slice(slash + 1);
  } else {
    host = BARE.find(([pattern]) => pattern.test(model))?.[1];
    if (!host) throw new RouteError(`cannot tell which CLI runs "${spec}"; prefix it (anthropic/, openai/)`);
  }
  if (!model) throw new RouteError(`empty model in "${spec}"`);
  if (effortText === undefined) return { host, model };
  const effort = effortText === 'off' ? 'minimal' : effortText;
  if (!isEffort(effort)) throw new RouteError(`unknown effort "${effortText}" in "${spec}"`);
  return { host, model, effort: clampEffort(host, effort) };
}

function fromSpec(spec: string, strategy: Route['strategy'], reason?: string, effort?: Effort): Route {
  const parsed = parseModel(spec);
  const chosen = effort ?? parsed.effort ?? 'high';
  return { host: parsed.host, model: parsed.model, effort: clampEffort(parsed.host, chosen), strategy, ...(reason ? { reason } : {}) };
}

interface RouterDecision {
  selected: { model: string; thinking: string };
  strategy: 'jev' | 'fallback' | 'pinned';
  reason?: string;
}

export type RouterCall = (request: { role: Role; task: string; harness: 'native' }) => Promise<RouterDecision>;

export function routerCall(config: Config): RouterCall {
  return request => new Promise((resolve, reject) => {
    const child = execFile(config.router.command, ['route', '--file', '-', '--dry-run'],
      { timeout: config.router.timeoutMs, maxBuffer: 8_000_000 },
      (error, stdout, stderr) => {
        if (error) return reject(new RouteError(`agent-router failed: ${(stderr || error.message).trim().split('\n').pop()}`));
        try { resolve(JSON.parse(stdout) as RouterDecision); }
        catch { reject(new RouteError('agent-router returned non-JSON output')); }
      });
    child.stdin?.end(JSON.stringify(request));
  });
}

export interface RouteInput {
  role: Role;
  task: string;
  model?: string;
  effort?: Effort;
}

/** Pinned model wins; otherwise Jev picks; any router failure degrades to the role default. */
export async function route(input: RouteInput, config: Config, call: RouterCall = routerCall(config)): Promise<Route> {
  if (input.model) return fromSpec(input.model, 'pinned', undefined, input.effort);
  if (config.router.enabled) {
    try {
      const decision = await call({ role: input.role, task: input.task.slice(0, 12_000), harness: 'native' });
      const { model, thinking } = decision.selected;
      const effort = thinking === 'off' ? 'minimal' : thinking;
      return fromSpec(model, decision.strategy, decision.reason, input.effort ?? (isEffort(effort) ? effort : undefined));
    } catch (error) {
      return fromSpec(config.defaults[input.role], 'default', (error as Error).message, input.effort);
    }
  }
  return fromSpec(config.defaults[input.role], 'default', 'router disabled', input.effort);
}
