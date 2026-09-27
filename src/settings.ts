import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ancestry } from './identity.ts';
import { alive, home, readJson, writeJson } from './store.ts';
import type { Address, Config } from './types.ts';

/**
 * Per-session overrides. Precedence: CREW_ROUTER in the environment (children inherit it),
 * then an agent session's override, then a terminal shell's override (applies to every
 * session launched from that shell), then the config file.
 */
export interface RouterSetting { on: boolean; source: 'env' | 'session' | 'shell' | 'config'; shell?: number }

const sessionsDir = (): string => join(home(), 'sessions');
const sessionFile = (mailbox: string): string => join(sessionsDir(), `${mailbox.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
const shellFile = (pid: number): string => join(sessionsDir(), `shell-${pid}.json`);

export function parseSwitch(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(off|0|false|no)$/i.test(value)) return false;
  if (/^(on|1|true|yes)$/i.test(value)) return true;
  return undefined;
}

export function routerSetting(
  config: Config, me: Address | undefined, env: NodeJS.ProcessEnv = process.env,
  shells: () => number[] = () => ancestry().map(proc => proc.pid),
): RouterSetting {
  const fromEnv = parseSwitch(env.CREW_ROUTER);
  if (fromEnv !== undefined) return { on: fromEnv, source: 'env' };
  const session = me ? readJson<{ router?: boolean }>(sessionFile(me.mailbox))?.router : undefined;
  if (session !== undefined) return { on: session, source: 'session' };
  for (const pid of shells()) {
    const shell = readJson<{ router?: boolean }>(shellFile(pid))?.router;
    if (shell !== undefined) return { on: shell, source: 'shell', shell: pid };
  }
  return { on: config.router.enabled, source: 'config' };
}

export function setSessionRouter(me: Address, on: boolean | undefined): void {
  const path = sessionFile(me.mailbox);
  const current = readJson<Record<string, unknown>>(path) ?? {};
  const { router: _, ...rest } = current;
  writeJson(path, on === undefined ? rest : { ...rest, router: on });
}

/** A terminal's override lives as long as its shell; files of exited shells are swept here. */
export function setShellRouter(pid: number, on: boolean | undefined): void {
  let names: string[] = [];
  try { names = readdirSync(sessionsDir()); } catch { /* none yet */ }
  for (const name of names) {
    const dead = name.match(/^shell-(\d+)\.json$/);
    if (dead && !alive(Number(dead[1]))) rmSync(join(sessionsDir(), name), { force: true });
  }
  if (on === undefined) rmSync(shellFile(pid), { force: true });
  else writeJson(shellFile(pid), { router: on });
}
