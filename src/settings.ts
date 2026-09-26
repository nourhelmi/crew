import { join } from 'node:path';
import { home, readJson, writeJson } from './store.ts';
import type { Address, Config } from './types.ts';

/**
 * Per-session overrides. Precedence: CREW_ROUTER in the environment (children inherit it),
 * then a session override written by `crew router on|off`, then the config file.
 */
export interface RouterSetting { on: boolean; source: 'env' | 'session' | 'config' }

const sessionFile = (mailbox: string): string => join(home(), 'sessions', `${mailbox.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);

export function parseSwitch(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(off|0|false|no)$/i.test(value)) return false;
  if (/^(on|1|true|yes)$/i.test(value)) return true;
  return undefined;
}

export function routerSetting(config: Config, me: Address | undefined, env: NodeJS.ProcessEnv = process.env): RouterSetting {
  const fromEnv = parseSwitch(env.CREW_ROUTER);
  if (fromEnv !== undefined) return { on: fromEnv, source: 'env' };
  const session = me ? readJson<{ router?: boolean }>(sessionFile(me.mailbox))?.router : undefined;
  if (session !== undefined) return { on: session, source: 'session' };
  return { on: config.router.enabled, source: 'config' };
}

export function setSessionRouter(me: Address, on: boolean | undefined): void {
  const path = sessionFile(me.mailbox);
  const current = readJson<Record<string, unknown>>(path) ?? {};
  const { router: _, ...rest } = current;
  writeJson(path, on === undefined ? rest : { ...rest, router: on });
}
