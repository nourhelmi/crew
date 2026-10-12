import { execFileSync } from 'node:child_process';
import { closePane } from './herdr.ts';
import { bgActive, hostEnv } from './spawn.ts';
import { listRuns, mailDir, readRun, updateRun, withLock, writeJson } from './store.ts';
import { join } from 'node:path';
import type { RunMeta } from './types.ts';
import { ownedChild } from './console-children.ts';
import { processExists, terminateOwnedProcess, terminateOwnedTree } from './console-process.ts';
import { publicSession, readMeta, supervisorAlive } from './console-store.ts';

export async function stopRun(run: RunMeta, visited = new Set<string>(), waitForConsole = true): Promise<void> {
  if (visited.has(run.id)) return;
  visited.add(run.id);
  const { current, children } = withLock('spawn', () => ({
    current: updateRun(run.id, live => ({ ...live, state: 'stopped' })) ?? run,
    children: listRuns().filter(child => child.parent.mailbox === run.id),
  }));
  await Promise.all(children.map(child => stopRun(child, visited, waitForConsole)));
  if (current.launcher === 'console') {
    const meta = ownedChild(current);
    if (!meta) {
      // Failed policy validation can reserve a run without ever creating a pipe.
      if (!current.console || !readMeta(current.console.sessionId)) return;
      throw new Error(`crew: ${current.name} lacks verified console process ownership; stop refused`);
    }
    if (meta.identity?.provider) await terminateOwnedProcess(meta.identity.provider);
    if (waitForConsole) {
      const deadline = Date.now() + 35_000;
      for (;;) {
        const fresh = readRun(current.id);
        const live = fresh && ownedChild(fresh);
        if (!live) throw new Error(`crew: ${current.name}'s console ownership changed during stop`);
        // A startup can record its provider after stop took the first snapshot.
        if (live.identity?.provider) await terminateOwnedProcess(live.identity.provider);
        if (!supervisorAlive(live) || publicSession(current.console!.sessionId)?.state === 'closed') break;
        if (Date.now() >= deadline) throw new Error(`crew: ${current.name}'s owned supervisor did not finish retirement; retry crew stop`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return;
  }
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
    if (current.ownedProcess?.pid === current.pid) await terminateOwnedTree(current.ownedProcess);
    else if (processExists(current.pid)) throw new Error(`crew: ${current.name} lacks recorded exec process ownership; stop through its original host`);
  }
}


/** Mark the real root mailbox retired before taking the descendant snapshot. */
export async function retireRoot(mailbox: string, consoleSessionId: string): Promise<void> {
  const children = withLock('spawn', () => {
    writeJson(join(mailDir(mailbox), 'console-retired.json'), { consoleSessionId, at: new Date().toISOString() });
    return listRuns().filter(child => child.parent.mailbox === mailbox);
  });
  const failures: string[] = [];
  await Promise.all(children.map(async child => { try { await stopRun(child); } catch (error) { failures.push(error instanceof Error ? error.message : 'Descendant stop failed.'); } }));
  if (failures.length) throw new Error(failures.join('\n'));
}
