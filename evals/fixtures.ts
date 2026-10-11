import { scenarios } from './scenarios.ts';
import type { Observation, Report } from './scenarios.ts';
import { score } from './score.ts';

/** Synthetic observations are scorer examples, not recordings of model work. */
export function fixture(scenario: (typeof scenarios)[number]): Observation {
  return {
    case: scenario.id, launchCount: scenario.id === 'cos-integration-reuse' ? 2 : 0,
    facts: Object.fromEntries(scenario.assertions.map(id => [id, {
      holds: true, kind: 'artifact', paths: [`fixture:${scenario.id}/${id}`], detail: 'Synthetic positive fixture.',
    }])),
  };
}

export function runFixtures(): Report {
  const started = Date.now();
  const cases = scenarios.map(scenario => {
    const positive = fixture(scenario);
    const result = score(positive);
    if (result.status !== 'pass') throw new Error(`Positive fixture failed: ${scenario.id}`);
    // Every assertion must detect both a counterexample and missing evidence.
    for (const id of scenario.assertions) {
      const negative = structuredClone(positive);
      negative.facts[id]!.holds = false;
      if (score(negative).assertions.find(a => a.id === id)?.status !== 'fail') throw new Error(`Blind scorer: ${id}`);
      negative.facts[id]!.holds = true;
      negative.facts[id]!.paths = [];
      if (score(negative).assertions.find(a => a.id === id)?.status !== 'fail') throw new Error(`Unbacked assertion: ${id}`);
      delete negative.facts[id];
      if (score(negative).assertions.find(a => a.id === id)?.status !== 'not-executed') throw new Error(`Missing evidence passed: ${id}`);
    }
    return result;
  });
  return {
    schema: 1, mode: 'fixtures', proof: 'scorer-fixtures-only', model: null, status: 'pass',
    durationMs: Date.now() - started, launchCount: 0, evidencePaths: [],
    cases: cases.map(c => ({ ...c, launchCount: 0 })),
    note: 'Positive, counterexample and missing-evidence scorer checks only. No model, provider, Crew launch or E2E behavior was exercised.',
  };
}
