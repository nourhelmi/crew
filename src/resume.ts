import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bgSession, hostEnv, launchClaudeBg, launchExec, ROOT } from './spawn.ts';
import { alive, home, mtime, readRun, runDir, unread, updateRun, withLockAsync } from './store.ts';
import type { RunMeta } from './types.ts';

/** Do not diagnose the intentional host exit in the middle of a serialized relaunch. */
export function resuming(id: string): boolean {
  const at = mtime(join(home(), 'locks', `resume-${id}`));
  return at !== undefined && Date.now() - at < 120_000;
}

/** Schedule a headless turn without blocking the sender's mailbox/run locks. */
export function requestResume(run: RunMeta): boolean {
  if (run.launcher === 'herdr' || run.state === 'stopped' || !run.sessionId || !run.launch) return false;
  if (unread(run.id).mails.at(-1)?.id === run.resumedMail) return false;
  const log = openSync(join(runDir(run.id), 'resume.log'), 'a');
  try {
    const child = spawnProcess(join(ROOT, 'bin', 'crew'), ['resume', run.id, '--quiet'], {
      cwd: run.cwd, env: { ...process.env, CREW_NODE: process.execPath, CREW_NO_DELEGATE: '1' }, detached: true, stdio: ['ignore', log, log],
    });
    child.on('error', () => {}); // The parent watcher retries unread mail; errors stay in resume.log.
    child.unref();
    return Boolean(child.pid);
  } finally { closeSync(log); }
}

/** Resume the recorded session; never clone a busy worker, reroute, or revive an explicit stop. */
export async function resume(id: string, force = false): Promise<boolean> {
  const requestedTurn = readRun(id)?.turn ?? 0;
  return withLockAsync(`resume-${id}`, async () => {
    const run = readRun(id);
    if (!run) throw new Error(`crew: no run matches "${id}"`);
    if (run.state === 'stopped') throw new Error(`crew: ${run.name} is stopped; spawn a new run for new work`);
    if (run.launcher === 'herdr') throw new Error(`crew: ${run.name} uses a Herdr pane; wake it with crew msg or crew amend`);
    if (!run.launch || !run.sessionId) throw new Error(`crew: ${run.name} lacks recorded launch/session data; spawn a new run`);
    if ((run.turn ?? 0) !== requestedTurn) return false;
    const lastMail = unread(id).mails.at(-1)?.id;
    if (!force && (!lastMail || lastMail === run.resumedMail)) return false;
    (await import('./wait.ts')).ensureWatcher(run.parent.mailbox);
    if (run.launcher === 'exec' && alive(run.pid)) return false;
    if (run.launcher === 'bg') {
      const session = bgSession(run.bgId ?? run.sessionId, run.launch.env);
      // Claude copies --resume when already running: only a positively idle session is safe.
      if (!session || session === 'unknown' || !['done', 'idle', 'completed', 'stopped', 'exited'].includes(session.status ?? '')) return false;
    }
    const prompt = `Read your standing brief at ${join(runDir(id), 'brief.md')} and current packet at ${join(runDir(id), 'packet.md')}. `
      + 'Run crew inbox now. Continue this same assignment/session under the packet; plain messages are advice.';
    const args = [...run.launch.args.slice(0, -1), prompt];
    updateRun(id, current => current.state === 'stopped' ? undefined : {
      ...current, state: 'running', turn: requestedTurn + 1, ...(lastMail ? { resumedMail: lastMail } : {}),
    });
    if (readRun(id)?.state === 'stopped') return false;
    try { unlinkSync(join(runDir(id), '.stalled')); } catch { /* new liveness episode */ }
    let launched;
    try {
      launched = run.launcher === 'bg' ? launchClaudeBg(run, args, run.launch.env, true)
        : await launchExec(run, args, run.launch.env, true);
    } catch (error) {
      (await import('./mail.ts')).stall(id, `resume failed: ${(error as Error).message.split('\n')[0]!.slice(0, 200)}`);
      throw error;
    }
    const fresh = updateRun(id, current => current.state === 'stopped' ? undefined : { ...current, ...launched });
    if (fresh?.state === 'stopped') {
      if (launched.pid) { try { process.kill(-launched.pid, 'SIGTERM'); } catch { /* exited */ } }
      if (launched.bgId) { try { execFileSync('claude', ['stop', launched.bgId], { env: hostEnv(run.launch.env), stdio: 'ignore', timeout: 20_000 }); } catch { /* exited */ } }
      return false;
    }
    (await import('./wait.ts')).ensureWatcher(run.parent.mailbox);
    return true;
  });
}
