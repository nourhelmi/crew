import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RESULT_HEADINGS = ['Status', 'Claims', 'Evidence', 'Files', 'Decisions', 'Remaining Risk'] as const;

export type Verdict = 'done' | 'blocked' | 'failed';

export interface ResultStatus {
  verdict: Verdict;
  /** First line under Status, verbatim. */
  line: string;
  hash: string;
}

const TERMINAL: ReadonlyArray<readonly [RegExp, Verdict]> = [
  [/^(DONE|PASS(ED)?)\b/i, 'done'],
  [/^BLOCKED\b/i, 'blocked'],
  [/^FAIL(ED|URE)?\b/i, 'failed'],
];

/** Terminal status of a result document, or undefined while it is missing or in progress. */
export function parseResult(text: string): Omit<ResultStatus, 'hash'> | undefined {
  const lines = text.split('\n').map(line => line.trim());
  const heading = lines.findIndex(line => /^#{1,6}\s*status\b/i.test(line) || /^status\s*:/i.test(line));
  if (heading < 0) return undefined;
  const inline = lines[heading]!.match(/^status\s*:\s*(.+)$/i)?.[1];
  const line = inline ?? lines.slice(heading + 1).find(Boolean);
  if (!line || /^#/.test(line)) return undefined;
  const cleaned = line.replace(/^[-*>\s`*_]+|[`*_]+$/g, '').trim();
  const verdict = TERMINAL.find(([pattern]) => pattern.test(cleaned))?.[1];
  return verdict ? { verdict, line: cleaned } : undefined;
}

/** A kept teammate's mid-assignment status (`IN PROGRESS: <next step>`); it settles nothing. */
export function progressLine(path: string): string | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  const lines = text.split('\n').map(line => line.trim());
  const heading = lines.findIndex(line => /^#{1,6}\s*status\b/i.test(line) || /^status\s*:/i.test(line));
  if (heading < 0) return undefined;
  const line = (lines[heading]!.match(/^status\s*:\s*(.+)$/i)?.[1] ?? lines.slice(heading + 1).find(Boolean) ?? '')
    .replace(/^[-*>\s`*_]+|[`*_]+$/g, '').trim();
  return /^IN[ _-]PROGRESS\b/i.test(line) ? line : undefined;
}

export function readResult(path: string): ResultStatus | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  const status = parseResult(text);
  return status && { ...status, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

export function contract(path: string): string {
  return [
    `Write your complete result to exactly: ${path}`,
    `Use these top-level headings: ${RESULT_HEADINGS.join(', ')}.`,
    'When you finish, the first nonempty line under Status must be terminal: DONE, PASS, FAIL, or BLOCKED: <reason>.',
    'While still working, a draft says IN PROGRESS; never use BLOCKED or FAIL as a placeholder, because they report to your parent.',
    'Map Claims one-to-one to the packet\'s done-when criteria, with command or artifact evidence for each.',
  ].join('\n');
}
