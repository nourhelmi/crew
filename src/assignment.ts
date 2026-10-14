import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseResult, readResult } from './result.ts';
import { findRun, listRuns, packetPath, resultPath, runDir, unread, updateRun } from './store.ts';
import type { Address, Assignment, RunMeta, Submission } from './types.ts';

/** Additive defaults: old runs acquire assignment metadata on their next change/submission. */
export function currentAssignment(run: RunMeta): Assignment {
  return run.assignment ?? { id: 'initial', revision: run.amendment?.number ?? 0,
    createdAt: run.createdAt, status: 'active', submissions: [] };
}

export function unaccepted(assignment: Assignment): Omit<Assignment, 'accepted'> {
  const { accepted: _, ...rest } = assignment;
  return rest;
}

export const packetMail = (run: RunMeta): boolean => unread(run.id).mails.some(m => m.kind === 'amendment' || m.kind === 'assignment');

export function submissionPath(id: string, ref: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ref)) throw new Error('crew: invalid submission reference');
  return join(runDir(id), 'submissions', `${ref}.md`);
}

/** Use one read for status, digest and snapshot; never snapshot a later rewrite under an old hash. */
export function candidate(id: string): { text: string; status: NonNullable<ReturnType<typeof readResult>> } | undefined {
  let text: string;
  try { text = readFileSync(resultPath(id), 'utf8'); } catch { return undefined; }
  const status = parseResult(text);
  return status && { text, status: { ...status, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) } };
}

export const packetHash = (id: string): string => createHash('sha256').update(readFileSync(packetPath(id))).digest('hex').slice(0, 16);

export function snapshot(id: string, assignment: Assignment, value: NonNullable<ReturnType<typeof candidate>>): Submission {
  const ref = `${assignment.id}-r${assignment.revision}-${value.status.hash}`;
  const result = submissionPath(id, ref);
  mkdirSync(join(runDir(id), 'submissions'), { recursive: true });
  try { writeFileSync(result, value.text, { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (readFileSync(result, 'utf8') !== value.text) throw new Error(`crew: immutable submission collision: ${ref}`);
  }
  return { ref, hash: value.status.hash, packetHash: packetHash(id), revision: assignment.revision,
    at: new Date().toISOString(), status: value.status.line, result };
}

/** Outstanding work, recursively. Idle/submitted members do not hold their parent's turn open. */
export function activeDescendants(id: string): RunMeta[] {
  const runs = listRuns();
  const visited = new Set([id]);
  const active: RunMeta[] = [];
  const walk = (parent: string) => {
    for (const run of runs.filter(r => r.parent.mailbox === parent && !visited.has(r.id))) {
      visited.add(run.id);
      if (run.state === 'running') active.push(run);
      walk(run.id);
    }
  };
  walk(id);
  return active;
}

/** The exact current submission to accept, or why `submission` is not it, named precisely enough to act on. */
function acceptable(run: RunMeta, submission: string): { assignment: Assignment; record: Submission } | string {
  const assignment = run.assignment;
  if (run.state === 'stopped') return `${run.name} is stopped, and a stopped run's submissions cannot be accepted; accept before \`crew stop\``;
  if (!assignment) return `${run.name} has no submitted assignment yet`;
  const record = assignment.submissions.find(s => s.ref === submission);
  const current = `${run.name}'s current submission is ${assignment.submission ?? 'none yet'}`;
  if (!record) return `stale or unknown submission ${submission}; ${current}`;
  if (assignment.status === 'active') return `stale submission ${submission}: ${run.name}'s assignment is active again; accept its next submission once it settles`;
  if (assignment.submission !== submission || record.revision !== assignment.revision) return `stale submission ${submission}; ${current}`;
  if (packetMail(run)) return `stale submission ${submission}: ${run.name} has an unread amendment; accept its resubmission once it settles`;
  if (readResult(resultPath(run.id))?.hash !== record.hash) return `stale submission ${submission}: ${run.name} changed its result since; accept the newer submission once it settles`;
  if (readResult(record.result)?.hash !== record.hash) return `stale submission ${submission}: its snapshot no longer matches the recorded hash`;
  if (packetHash(run.id) !== record.packetHash) return `stale submission ${submission}: ${run.name}'s packet changed since; accept its resubmission once it settles`;
  return { assignment, record };
}

/** Acceptance names the exact current immutable submission, never merely a member or DONE. */
export function accept(from: Address, ref: string, submission: string): RunMeta {
  const run = findRun(ref);
  if (!run) throw new Error(`crew: no run matches "${ref}"`);
  return updateRun(run.id, current => {
    if (current.parent.mailbox !== from.mailbox) throw new Error(`crew: only ${current.name}'s parent can accept its submission`);
    const found = acceptable(current, submission);
    if (typeof found === 'string') throw new Error(`crew: ${found}`);
    const { assignment, record } = found;
    if (!/^(DONE|PASS(ED)?)\b/i.test(record.status)) throw new Error('crew: blocked/failed submissions cannot be accepted as delivered outcomes');
    if (activeDescendants(current.id).length) throw new Error('crew: active descendants must settle before acceptance');
    const accepted = { submission, at: assignment.accepted?.at ?? new Date().toISOString(), by: from.mailbox };
    return { ...current, assignment: { ...assignment, status: 'accepted', accepted,
      submissions: assignment.submissions.map(s => s.ref === submission ? { ...s, accepted } : s) } };
  })!;
}
