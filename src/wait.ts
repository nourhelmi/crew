import { setTimeout as sleep } from 'node:timers/promises';
import { agentStatus, closePane, type AgentStatus } from './herdr.ts';
import { self } from './identity.ts';
import { format, settle, stall, takeUnread, waiting } from './mail.ts';
import { readResult } from './result.ts';
import { bgSession } from './spawn.ts';
import { alive, listRuns, markWaiter, readRun, resultPath, writeRun } from './store.ts';
import type { Mail, RunMeta } from './types.ts';

const LIVENESS_EVERY_MS = 5_000;
const BG_EVERY_MS = 20_000;
const BATCH_MS = 750;

/** Why a live child is gone, or undefined while it still runs. */
function gone(run: RunMeta, herdrStatus: AgentStatus | undefined, checkBg: boolean): string | undefined {
  if (run.launcher === 'herdr') return herdrStatus ? undefined : 'its herdr agent exited';
  if (run.launcher === 'exec') return alive(run.pid) ? undefined : 'codex exec exited';
  if (run.launcher === 'bg' && checkBg) {
    const session = bgSession(run.name);
    if (!session) return 'its background session is gone';
    return /exit|stop|fail|dead|complete/i.test(session.status ?? '') ? `its background session is ${session.status}` : undefined;
  }
  return undefined;
}

function sweep(mailbox: string, checkBg: boolean): void {
  for (const run of listRuns()) {
    if (run.parent.mailbox !== mailbox) continue;
    if (run.state === 'running' || run.state === 'stalled') {
      // Parent-side settlement covers a child whose Stop hook never ran.
      const hasResult = Boolean(readResult(resultPath(run.id)));
      if (hasResult) settle(run.id);
      if (run.state === 'running') {
        const status = run.herdr && !run.herdr.closed ? agentStatus(run.herdr.agent) : undefined;
        // An approval or question dialog in the child's pane needs a human or the parent.
        waiting(run.id, status === 'blocked');
        if (!hasResult || run.keep) {
          const why = gone(run, status, checkBg);
          if (why) stall(run.id, why);
        }
      }
    }
    const fresh = readRun(run.id);
    // Tidy finished, non-kept herdr panes once the agent has gone quiet; failures stay open for inspection.
    if (fresh?.state === 'done' && !fresh.keep && fresh.herdr && !fresh.herdr.closed) {
      const status = agentStatus(fresh.herdr.agent);
      if (status === 'working' || status === 'blocked') continue;
      if (status) closePane(fresh.herdr.pane);
      writeRun({ ...fresh, herdr: { ...fresh.herdr, closed: true } });
    }
  }
}

/**
 * Block until this session has mail (child settlements, stalls, messages), then print it and exit.
 * On Claude run it as a background Bash command: its exit re-invokes the session.
 */
export async function wait(timeoutMs: number): Promise<Mail[]> {
  const me = self();
  const release = markWaiter(me.mailbox);
  const deadline = Date.now() + timeoutMs;
  let lastSweep = 0;
  let lastBg = 0;
  try {
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now - lastSweep >= LIVENESS_EVERY_MS) {
        const checkBg = now - lastBg >= BG_EVERY_MS;
        sweep(me.mailbox, checkBg);
        lastSweep = now;
        if (checkBg) lastBg = now;
      }
      const mails = takeUnread(me.mailbox);
      if (mails.length) {
        await sleep(BATCH_MS);
        return mails.concat(takeUnread(me.mailbox));
      }
      await sleep(1_000);
    }
    return [];
  } finally {
    release();
  }
}

export function liveChildren(mailbox: string): RunMeta[] {
  return listRuns().filter(run => run.parent.mailbox === mailbox && run.state === 'running');
}

export { format };
