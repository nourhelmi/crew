import { scenarios } from './scenarios.ts';
import type { CaseResult, Observation, Scenario } from './scenarios.ts';

export function score(observation: Observation, durationMs = 0): CaseResult {
  const scenario = scenarios.find(s => s.id === observation.case)!;
  const assertions = scenario.assertions.map(id => {
    const fact = observation.facts[id];
    const status = !fact ? 'not-executed' : fact.holds && fact.paths.length > 0 ? 'pass' : 'fail';
    return { id, status, evidence: fact?.paths ?? [], detail: fact?.detail ?? 'No captured evidence; not evaluated.' } as const;
  });
  return {
    case: observation.case,
    status: assertions.some(a => a.status === 'fail') ? 'fail'
      : assertions.some(a => a.status === 'not-executed') ? 'not-executed' : 'pass',
    assertions, launchCount: observation.launchCount, durationMs,
  };
}

export const unexecuted = (scenario: Scenario): CaseResult => score({ case: scenario.id, facts: {}, launchCount: 0 });
