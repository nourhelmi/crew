/** Fixtures exercise scorers; only tool-backed captures can establish model behavior. */
export const scenarios = [
  {
    id: 'cos-integration-reuse', live: true,
    outcome: 'Independent retained advisors deliver useful artifacts; CoS integrates exact accepted results and reuses an owner.',
    assertions: ['independent-advisors', 'advisor-artifacts', 'integrated-output', 'exact-acceptance', 'retained-reuse', 'immutable-prior-result', 'descendants-settled'],
  },
  {
    id: 'advisor-tiny-repair', live: true,
    outcome: 'An advisor makes and verifies a tiny repair directly without unnecessary staffing.',
    assertions: ['direct-repair', 'bounded-diff', 'repair-verified', 'no-unnecessary-launch'],
  },
  {
    id: 'handoff-levels', live: false,
    outcome: 'Advisor missions delegate judgment; worker packets bound execution.',
    assertions: ['advisor-decision-rights', 'worker-edit-boundary', 'no-mission-recipe'],
  },
  {
    id: 'checker-repair', live: false,
    outcome: 'A checker distinguishes as-found failure from its bounded repaired result.',
    assertions: ['as-found-separated', 'repair-in-scope', 'repaired-delta-verified'],
  },
  {
    id: 'compaction-recovery', live: false,
    outcome: 'Recovered context preserves ownership, current assignment and the next action.',
    assertions: ['current-contract-recovered', 'ownership-preserved', 'resumed-next-action'],
  },
  {
    id: 'precise-acceptance', live: false,
    outcome: 'Stale submission acceptance fails; the current exact ref is accepted without rewriting history.',
    assertions: ['stale-ref-rejected', 'current-ref-accepted', 'prior-submission-preserved'],
  },
] as const;

export type Scenario = (typeof scenarios)[number];
export type CaseId = Scenario['id'];
export const consoleAssertions = ['console-identity', 'console-delivery', 'console-idempotency',
  'console-reconnect', 'second-human-input', 'nonce-artifact'] as const;
export type EvalSurface = 'fixtures' | 'cli' | 'console-api';
export type AssertionId = Scenario['assertions'][number] | (typeof consoleAssertions)[number];
export type EvidenceKind = 'artifact' | 'tool' | 'runtime' | 'review';
export interface Observation {
  case: CaseId;
  surface?: 'cli' | 'console-api';
  /** Populated from captured artifacts/receipts, never the model's declared PASS. */
  facts: Partial<Record<AssertionId, { holds: boolean; kind: EvidenceKind; paths: string[]; detail: string }>>;
  launchCount: number;
}
export interface Assertion {
  id: AssertionId;
  status: 'pass' | 'fail' | 'not-executed';
  evidence: string[];
  detail: string;
}
export interface CaseResult {
  case: CaseId;
  status: 'pass' | 'fail' | 'not-executed' | 'blocked';
  assertions: Assertion[];
  launchCount: number;
  durationMs: number;
}
export interface Report {
  schema: 1;
  surface: EvalSurface;
  mode: 'fixtures' | 'live';
  proof: 'scorer-fixtures-only' | 'real-provider-tools';
  model: string | null;
  status: 'pass' | 'fail' | 'blocked';
  durationMs: number;
  launchCount: number;
  evidencePaths: string[];
  cases: CaseResult[];
  note: string;
}
