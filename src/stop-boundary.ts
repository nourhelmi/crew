import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { listRuns, mailDir, readJson, readRun, withLock, writeJson } from './store.ts';

const epochPath = (mailbox: string): string => join(mailDir(mailbox), 'stop-epoch.json');
const epoch = (mailbox: string): string | null => readJson<{ epoch: string }>(epochPath(mailbox))?.epoch ?? null;

/** Capture before asynchronous routing; reservation checks it inside the spawn lock. */
export function rootSpawnBoundary(parent: string): { mailbox: string; epoch: string | null } {
  const seen = new Set<string>();
  let mailbox = parent;
  for (;;) {
    if (seen.has(mailbox)) throw new Error('crew: cyclic parent ancestry cannot launch descendants');
    seen.add(mailbox);
    const run = readRun(mailbox);
    if (!run) return { mailbox, epoch: epoch(mailbox) };
    mailbox = run.parent.mailbox;
  }
}

export function assertSpawnBoundary(boundary: ReturnType<typeof rootSpawnBoundary>): void {
  if (epoch(boundary.mailbox) !== boundary.epoch) {
    throw new Error('crew: parent was stopped while this spawn was routing; launch cancelled');
  }
}

/** Cancel a native root's current work without permanently retiring its reusable identity. */
export async function stopRootChildren(mailbox: string): Promise<void> {
  if (!/^(codex|claude|opencode)-[A-Za-z0-9_-]{1,160}$/.test(mailbox)) {
    throw new Error('crew: --children-of requires a native host session mailbox');
  }
  const children = withLock('spawn', () => {
    writeJson(epochPath(mailbox), { epoch: randomUUID() });
    return listRuns().filter(run => run.parent.mailbox === mailbox);
  });
  const { stopRun } = await import('./retire.ts');
  const results = await Promise.allSettled(children.map(run => stopRun(run)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'crew: some children could not be stopped; retry stop');
}
