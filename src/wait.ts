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

type Bg = ReturnType<typeof bgSession>;

/** Why a live child is gone, or undefined while it still runs (or was not checked this sweep). */
function gone(run: RunMeta, herdrStatus: AgentStatus | undefined, bg: Bg | 'unchecked'): string | undefined {
  if (run.launcher === 'herdr') return herdrStatus ? undefined : 'its herdr agent exited';
  if (run.launcher === 'exec') return alive(run.pid) ? undefined : 'codex exec exited';
  if (run.launcher === 'bg' && bg !== 'unchecked') {
    if (!bg) return 'its background session is gone';
    // "done" only means idle; a turn that ended without a result is the Stop hook's call.
    return /exit|stop|fail|dead|kill/i.test(bg.status ?? '') ? `its background session is ${bg.status}` : undefined;
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
        const herdrStatus = run.herdr && !run.herdr.closed ? agentStatus(run.herdr.agent, run.herdr.session) : undefined;
        const bg: Bg | 'unchecked' = run.launcher === 'bg' && checkBg ? bgSession(run.name) : 'unchecked';
        // An approval, question or folder-trust dialog needs a human or the parent.
        if (run.launcher === 'herdr') waiting(run.id, herdrStatus === 'blocked');
        if (bg !== 'unchecked') waiting(run.id, bg?.status === 'blocked');
        if (!hasResult || run.keep) {
          const why = gone(run, herdrStatus, bg);
          if (why) stall(run.id, why);
        }
      }
    }
    const fresh = readRun(run.id);
    // Tidy finished, non-kept herdr panes once the agent has gone quiet; failures stay open for inspection.
    if (fresh?.state === 'done' && !fresh.keep && fresh.herdr && !fresh.herdr.closed) {
      const status = agentStatus(fresh.herdr.agent, fresh.herdr.session);
      if (status === 'working' || status === 'blocked') continue;
      if (status) closePane(fresh.herdr.pane, fresh.herdr.session);
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
