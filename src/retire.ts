import { execFileSync } from 'node:child_process';
import { closePane } from './herdr.ts';
import { bgActive, hostEnv } from './spawn.ts';
import { listRuns, mailDir, updateRun, withLock, writeJson } from './store.ts';
import { join } from 'node:path';
import type { RunMeta } from './types.ts';

export function stopRun(run: RunMeta, visited = new Set<string>()): void {
  if (visited.has(run.id)) return;
  visited.add(run.id);
  const { current, children } = withLock('spawn', () => ({
    current: updateRun(run.id, live => ({ ...live, state: 'stopped' })) ?? run,
    children: listRuns().filter(child => child.parent.mailbox === run.id),
  }));
  for (const child of children) stopRun(child, visited);
  if (current.herdr && !current.herdr.closed) {
    if (!closePane(current.herdr.pane, current.herdr.session)) throw new Error(`crew: ${current.name} is marked stopped, but its pane close failed; retry crew stop`);
    updateRun(current.id, live => live.herdr ? { ...live, herdr: { ...live.herdr, closed: true } } : undefined);
  }
  if (current.bgId) {
    try { execFileSync('claude', ['stop', current.bgId], { env: hostEnv(current.launch?.env), stdio: 'ignore', timeout: 20_000 }); }
    catch {
      if (bgActive(current.bgId, current.launch?.env) !== false) throw new Error(`crew: ${current.name} is marked stopped, but its background stop failed; retry crew stop`);
    }
  }
  if (current.pid) {
    try { process.kill(-current.pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}


/** Mark the real root mailbox retired before taking the descendant snapshot. */
export function retireRoot(mailbox: string, consoleSessionId: string): void {
  const children = withLock('spawn', () => {
    writeJson(join(mailDir(mailbox), 'console-retired.json'), { consoleSessionId, at: new Date().toISOString() });
    return listRuns().filter(child => child.parent.mailbox === mailbox);
  });
  const failures: string[] = [];
  for (const child of children) { try { stopRun(child); } catch (error) { failures.push(error instanceof Error ? error.message : 'Descendant stop failed.'); } }
  if (failures.length) throw new Error(failures.join('\n'));
}
