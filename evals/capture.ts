import { createHash } from 'node:crypto';
import { scenarios } from './scenarios.ts';
import { score, unexecuted } from './score.ts';
import type { AssertionId, Observation, Report } from './scenarios.ts';

export interface Submission { ref: string; hash: string; revision: number; result: string }
export interface Assignment {
  id: string; revision: number; status: string; submission?: string; submissions: Submission[];
  accepted?: { submission: string; by: string };
}
export interface Run {
  id: string; name?: string; role: string; keep: boolean; state: string; sessionId?: string;
  parent: { mailbox: string }; assignment?: Assignment; assignmentHistory?: Assignment[];
}
export interface Receipt {
  args: string[]; caller: string; exitCode: number; stdout: string;
  /** Snapshot before the mutation, captured outside the model. */
  before: Record<string, string>;
  cwd?: string;
  after?: Record<string, string>;
}
export interface LiveCapture {
  runs: Run[];
  receipts: Receipt[];
  files: Record<string, string>;
  rootTranscript: string;
  childTranscripts: Record<string, string>;
}
export const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const json = (text: string | undefined): Record<string, unknown> => { try { return JSON.parse(text ?? ''); } catch { return {}; } };

/** Live facts come from runtime snapshots, actual executed tools and artifact contents. */
export function scoreCapture(capture: LiveCapture, model: string, durationMs: number): Report {
  const facts: Observation['facts'] = {};
  const fact = (id: AssertionId, holds: boolean, detail: string, paths = ['capture.json']) => {
    facts[id] = { holds, kind: 'runtime', detail, paths };
  };
  const executedTools = (text: string) => text.split('\n').some(line => {
    try { const event = JSON.parse(line); return event.type === 'item.completed' && event.item?.type === 'command_execution' && event.item?.exit_code === 0; }
    catch { return false; }
  });
  const advisors = capture.runs.filter(r => r.role === 'advisor' && r.keep && r.parent.mailbox.startsWith('codex-')
    && executedTools(capture.childTranscripts[r.id] ?? ''));
  const rootMailboxes = new Set(advisors.map(r => r.parent.mailbox));
  fact('independent-advisors', advisors.length >= 2 && rootMailboxes.size === 1 && executedTools(capture.rootTranscript),
    `${advisors.length} retained advisors have successful real tool events; ${rootMailboxes.size} parent mailbox(s).`);
  const stock = json(capture.files['workspace/stock/summary.json']);
  const sales = json(capture.files['workspace/sales/summary.json']);
  const output = json(capture.files['workspace/release.json']);
  const stockOwner = advisors.find(r => r.id === stock.owner);
  const salesOwner = advisors.find(r => r.id === sales.owner);
  const produced = (run: Run | undefined, path: string, content: string | undefined): boolean => Boolean(run && content !== undefined
    && capture.receipts.some(r => r.args[0] === 'codex' && r.args[1] === 'exec' && r.caller === run.id && r.exitCode === 0
      && r.before[path] !== content && r.after?.[path] === content));
  // The summaries are deliberately different domains; owners must be distinct real sessions.
  const artifactsGood = Boolean(stockOwner && salesOwner && stockOwner.id !== salesOwner.id
    && stockOwner.sessionId && salesOwner.sessionId && stockOwner.sessionId !== salesOwner.sessionId
    && stock.tea === 9 && stock.coffee === 3 && sales.grossCents === 1700 && sales.orders === 3
    && produced(stockOwner, 'workspace/stock/summary.json', capture.files['workspace/stock/summary.json'])
    && produced(salesOwner, 'workspace/sales/summary.json', capture.files['workspace/sales/summary.json']));
  fact('advisor-artifacts', artifactsGood, 'Distinct retained sessions with successful tool events and artifact-changing owner-turn receipts; correct stock and sales outputs.',
    ['workspace/stock/summary.json', 'workspace/sales/summary.json']);
  fact('integrated-output', artifactsGood && output.tea === 9 && output.coffee === 3 && output.grossCents === 1700 && output.orders === 3,
    'CoS combined release matches both delivered domains after follow-up.', ['workspace/release.json']);
  const assignments = advisors.flatMap(r => [r.assignment, ...(r.assignmentHistory ?? [])].filter((a): a is Assignment => Boolean(a))
    .map(a => ({ run: r, assignment: a })));
  const accepted = assignments.filter(({ run, assignment: a }) => {
    const submission = a.submissions.find(s => s.ref === a.accepted?.submission);
    const content = submission && capture.files[submission.result];
    const receipt = submission && capture.receipts.find(c => c.args[0] === 'accept' && (c.args[1] === run.id || c.args[1] === run.name)
      && c.args[2] === submission.ref && c.exitCode === 0 && c.caller === run.parent.mailbox);
    return a.status === 'accepted' && a.submission === submission?.ref && a.accepted?.by === run.parent.mailbox
      && submission?.revision === a.revision && content !== undefined && hash(content).slice(0, 16) === submission.hash && Boolean(receipt);
  });
  fact('exact-acceptance', accepted.length >= 3 && accepted.some(a => a.run.id === stockOwner?.id)
    && accepted.some(a => a.run.id === salesOwner?.id), 'At least three exact current-revision submissions accepted by their parent with successful tool receipts and matching hashes.');
  const reused = stockOwner && capture.receipts.find(c => c.args[0] === 'assign' && (c.args[1] === stockOwner.id || c.args[1] === stockOwner.name)
    && c.exitCode === 0 && c.caller === stockOwner.parent.mailbox);
  const prior = stockOwner?.assignmentHistory?.find(a => a.status === 'accepted');
  const sessions = new Set((capture.childTranscripts[stockOwner?.id ?? ''] ?? '').split('\n').flatMap(line => {
    try { const event = JSON.parse(line); return event.type === 'thread.started' ? [event.thread_id] : []; } catch { return []; }
  }));
  fact('retained-reuse', Boolean(reused && prior && stockOwner?.assignment?.id !== prior.id && sessions.size === 1 && sessions.has(stockOwner?.sessionId)),
    'Stock outcome reused the same retained run and provider session for a distinct assignment.');
  const priorSubmission = prior?.submissions.find(s => s.ref === prior.accepted?.submission);
  const before = priorSubmission && reused?.before[priorSubmission.result];
  const initialStock = json(reused?.before['workspace/stock/summary.json']);
  fact('immutable-prior-result', Boolean(priorSubmission && before !== undefined
    && capture.files[priorSubmission.result] === before && hash(before).slice(0, 16) === priorSubmission.hash
    && initialStock.tea === 7 && initialStock.coffee === 3 && initialStock.owner === stockOwner?.id
    && produced(stockOwner, 'workspace/stock/summary.json', reused?.before['workspace/stock/summary.json'])),
    'Correct initial stock and prior accepted snapshot captured before assign; immutable bytes and recorded hash preserved.');
  fact('descendants-settled', capture.runs.length > 0 && capture.runs.every(r => ['idle', 'done', 'stopped'].includes(r.state))
    && capture.runs.every(r => [r.assignment, ...(r.assignmentHistory ?? [])].every(a => a?.status === 'accepted')),
    'Every launched descendant is accounted for; all used assignments accepted.');
  const evaluated = score({ case: 'cos-integration-reuse', facts, launchCount: capture.runs.length }, durationMs);
  return {
    schema: 1, surface: 'cli', mode: 'live', proof: 'real-provider-tools', model,
    status: evaluated.status === 'pass' ? 'pass' : 'fail', durationMs, launchCount: capture.runs.length,
    evidencePaths: ['capture.json', 'root.jsonl', 'workspace/release.json'],
    cases: [evaluated, ...scenarios.filter(s => s.id !== evaluated.case).map(unexecuted)],
    note: 'Automatic result covers observed CoS tools, artifacts, acceptance and reuse only. Review missions/worker packets in evidence for judgment quality. Other catalog cases were not executed.',
  };
}

export const tinyVerifier = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.equal(JSON.parse(readFileSync(new URL('./greeting.json', import.meta.url))).message, 'Hello world');
console.log('greeting verified');
`;

export const tinyInstructions = '# Synthetic eval repo\nUse the provided advisor skill. Confine writes and subprocess state to the isolated sandbox. Fix only greeting.json; verify.mjs and these instructions are immutable. No external publishing.\n';

export function scoreTinyCapture(capture: LiveCapture, model: string, durationMs: number): Report {
  const good = json(capture.files['workspace/greeting.json']).message === 'Hello world';
  const events = capture.rootTranscript.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const tools = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution');
  // A command string can echo the verifier or skip it with shell control flow. Use
  // the independently recorded process receipt and bind it to the delivered bytes.
  const verified = capture.receipts.some(r => r.args[0] === 'node' && r.exitCode === 0 && r.caller.startsWith('codex-')
    && (r.args[1] === 'workspace/verify.mjs' || (r.cwd === 'workspace' && ['verify.mjs', './verify.mjs'].includes(r.args[1] ?? '')))
    && ['workspace/verify.mjs', 'workspace/greeting.json', 'workspace/AGENTS.md'].every(p =>
      r.before[p] === capture.files[p] && r.after?.[p] === capture.files[p]));
  const bounded = capture.files['workspace/verify.mjs'] === tinyVerifier
    && capture.files['workspace/AGENTS.md'] === tinyInstructions
    && Object.keys(capture.files).filter(p => p.startsWith('workspace/')).every(p =>
      ['workspace/greeting.json', 'workspace/verify.mjs', 'workspace/AGENTS.md', 'workspace/root-result.md'].includes(p));
  const facts: Observation['facts'] = {
    'direct-repair': { holds: good && tools.some(e => e.item.exit_code === 0), kind: 'artifact', paths: ['workspace/greeting.json', 'root.jsonl'], detail: 'Corrected real file with successful root command events.' },
    'bounded-diff': { holds: bounded, kind: 'artifact', paths: ['capture.json'], detail: 'Only greeting and result may change; immutable verifier/instructions and file inventory checked.' },
    'repair-verified': { holds: good && verified && bounded, kind: 'tool', paths: ['root.jsonl', 'workspace/verify.mjs'], detail: 'Successful execution of immutable node verify.mjs on repaired output.' },
    'no-unnecessary-launch': { holds: capture.runs.length === 0 && !capture.receipts.some(r => r.args[0] === 'spawn'), kind: 'runtime', paths: ['capture.json'], detail: 'No Crew runs or spawn attempts for the tiny direct repair.' },
  };
  const result = score({ case: 'advisor-tiny-repair', facts, launchCount: capture.runs.length }, durationMs);
  return {
    schema: 1, surface: 'cli', mode: 'live', proof: 'real-provider-tools', model, status: result.status === 'pass' ? 'pass' : 'fail',
    durationMs, launchCount: capture.runs.length, evidencePaths: ['capture.json', 'root.jsonl', 'workspace/greeting.json'],
    cases: [result, ...scenarios.filter(s => s.id !== result.case).map(unexecuted)],
    note: 'Observed direct advisor repair and immutable verifier execution. Other catalog cases were not executed.',
  };
}
