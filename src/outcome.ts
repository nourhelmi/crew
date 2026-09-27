import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultStatus } from './result.ts';
import { findRun, home, loadConfig, readRun, updateRun } from './store.ts';
import type { Address, RunMeta } from './types.ts';

/**
 * What routing learns from: a reviewed verdict on the work one model did in one role.
 * `review` is a checker's judgment of the run it was spawned to check; `grade` is the parent's.
 * A run's own DONE is never an outcome: makers rarely report their own misses.
 */
export interface Outcome {
  version: 1;
  id: string;
  at: string;
  model: string;
  thinking: string;
  role: string;
  signal: 'review' | 'grade';
  success: boolean;
  source: 'crew';
  run: string;
  note?: string;
}

export const outcomesPath = (): string => join(home(), 'outcomes.jsonl');

function outcome(run: RunMeta, signal: Outcome['signal'], success: boolean, id: string, note?: string): Outcome {
  return {
    version: 1, id, at: new Date().toISOString(), model: run.route.model, thinking: run.route.effort, role: run.role,
    signal, success, source: 'crew', run: run.id, ...(note?.trim() ? { note: note.trim().slice(0, 2000) } : {}),
  };
}

/** Kept in ~/.crew/outcomes.jsonl, then handed to the router. Returns whether the router took it. */
export function record(entry: Outcome): boolean {
  mkdirSync(home(), { recursive: true });
  appendFileSync(outcomesPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    execFileSync(loadConfig().router.command, ['outcomes', 'record', '--file', '-'],
      { input: JSON.stringify(entry), stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000 });
    return true;
  } catch { return false; }
}

/**
 * A checker spawned with --checks judges the work as it found it, before its own repairs:
 * HELD counts for the checked run's model, FIXED or BROKEN against it. Without that line only
 * a FAIL is unambiguous, because a PASS may follow the checker's repairs.
 */
export function reviewed(checker: RunMeta, status: ResultStatus): Outcome | undefined {
  if (!checker.checks) return undefined;
  const work = readRun(checker.checks);
  const success = status.found ? status.found === 'held' : status.verdict === 'failed' ? false : undefined;
  if (!work || success === undefined) return undefined;
  const entry = outcome(work, 'review', success, `crew:${checker.id}:${status.hash}`, `${checker.name}: ${status.line}`);
  record(entry);
  return entry;
}

/**
 * The parent's verdict on a child's work. Agents grade only their own children; a person in a
 * plain terminal (no crew session) may grade any run. Grading again replaces the earlier grade.
 */
export function grade(from: Address | undefined, ref: string, good: boolean, note?: string): { run: RunMeta; routed: boolean } {
  const run = findRun(ref);
  if (!run) throw new Error(`crew: no run matches "${ref}" (see crew ls)`);
  if (from && run.parent.mailbox !== from.mailbox) throw new Error(`crew: only ${run.name}'s parent can grade it`);
  const routed = record(outcome(run, 'grade', good, `crew:${run.id}:grade`, note));
  const at = new Date().toISOString();
  const graded = updateRun(run.id, meta => ({ ...meta, grade: { good, at, ...(note?.trim() ? { note: note.trim() } : {}) } })) ?? run;
  return { run: graded, routed };
}
