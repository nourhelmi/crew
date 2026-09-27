import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseModel } from './route.ts';
import { EFFORTS, ROLES, type Effort, type Role } from './types.ts';

/**
 * The models you can run and when each is worth it: one file, read by crew for role defaults and
 * by the router (its `rosterFile`) for routing. `model` is `<host>/<model id>`; file order is
 * preference within each role. The router documents every field; crew needs only a few.
 */
export interface RosterEntry {
  model: string;
  effort: Effort;
  roles: Role[];
  cost: number;
  about?: string;
  use: string;
  avoid?: string;
  scope?: 'small-or-verification';
  prior?: number;
  pool?: string;
  enabled?: boolean;
}

export const rosterPath = (): string => process.env.CREW_ROSTER || join(homedir(), '.config', 'crew', 'roster.json');

/** The roster, or undefined when there is none. Throws on a malformed one, naming the entry. */
export function loadRoster(path = rosterPath()): RosterEntry[] | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const models = (JSON.parse(raw) as { models?: unknown }).models;
  if (!Array.isArray(models) || !models.length) throw new Error(`crew: ${path} needs a nonempty "models" list`);
  return models.map((entry, index) => {
    const e = entry as RosterEntry;
    const where = `crew: ${path} models[${index}]`;
    if (typeof e.model !== 'string' || !/^[^/\s]+\/\S+$/.test(e.model)) throw new Error(`${where}: model must be "<host>/<model id>"`);
    if (!(EFFORTS as readonly string[]).includes(e.effort)) throw new Error(`${where}: effort must be one of ${EFFORTS.join(', ')}`);
    if (!Array.isArray(e.roles) || !e.roles.length || !e.roles.every(role => (ROLES as readonly string[]).includes(role))) {
      throw new Error(`${where}: roles must be some of ${ROLES.join(', ')}`);
    }
    if (typeof e.cost !== 'number' || e.cost < 0 || e.cost > 1) throw new Error(`${where}: cost must be 0..1`);
    if (typeof e.use !== 'string' || !e.use.trim()) throw new Error(`${where}: "use" says when to pick it`);
    return e;
  });
}

/** First enabled model crew can launch, per role: what spawns use when the router is off or fails. */
export function rosterDefaults(entries: RosterEntry[] | undefined): Partial<Record<Role, string>> {
  const defaults: Partial<Record<Role, string>> = {};
  for (const e of entries ?? []) {
    if (e.enabled === false || !runnable(e.model)) continue;
    for (const role of e.roles) defaults[role] ??= `${e.model}@${e.effort}`;
  }
  return defaults;
}

/** Why crew cannot launch this model, or undefined when it can. */
export function unrunnable(model: string): string | undefined {
  try { parseModel(model); return undefined; }
  catch (error) { return (error as Error).message; }
}
const runnable = (model: string): boolean => !unrunnable(model);
