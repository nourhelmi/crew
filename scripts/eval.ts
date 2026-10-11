import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runFixtures } from '../evals/fixtures.ts';
import { runLive } from '../evals/live.ts';
import { runConsoleLive } from '../evals/console-live.ts';
import { scenarios } from '../evals/scenarios.ts';
import type { LiveOptions } from '../evals/live.ts';

const usage = `Usage: npm run eval -- [--out DIR]
       npm run eval:live -- --model MODEL --codex-auth-file FILE [--surface cli|console-api] [--case CASE] [--timeout SECONDS] [--out DIR]
       npm run eval -- --list
Default: safe scorer fixtures only. Live: real Codex tools in temporary isolated homes.
CLI cases: cos-integration-reuse (default), advisor-tiny-repair. Console API: advisor-tiny-repair (default).
Console API proof does not establish browser behavior. Other policy probes remain not-executed.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); return; }
  if (args.includes('--list')) {
    for (const s of scenarios) console.log(`${s.id}\t${s.live ? 'live adapter + fixture' : 'fixture/policy probe only'}\t${s.outcome}`);
    return;
  }
  const live = args.includes('--live');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--live') continue;
    if (!['--out', '--model', '--codex-auth-file', '--timeout', '--codex-bin', '--case', '--surface'].includes(arg)) throw new Error(`Unknown argument ${arg}\n${usage}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (values.has(arg)) throw new Error(`Duplicate argument ${arg}`);
    values.set(arg, value);
  }
  const out = resolve(values.get('--out') ?? join(tmpdir(), 'crew-eval-results'));
  if (live) {
    const model = values.get('--model');
    if (!model || !/^(codex\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw new Error('Live eval requires an explicit valid --model (Codex model id).');
    const seconds = Number(values.get('--timeout') ?? '900');
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7200) throw new Error('--timeout must be 0 < seconds <= 7200.');
    const options: LiveOptions = { model, timeoutMs: Math.ceil(seconds * 1000), out };
    const surface = values.get('--surface') ?? 'cli';
    if (surface !== 'cli' && surface !== 'console-api') throw new Error('--surface must be cli or console-api.');
    const scenario = values.get('--case') ?? (surface === 'console-api' ? 'advisor-tiny-repair' : 'cos-integration-reuse');
    if (scenario !== 'cos-integration-reuse' && scenario !== 'advisor-tiny-repair') throw new Error(`No live adapter for case ${scenario}`);
    options.case = scenario;
    if (surface === 'console-api' && scenario !== 'advisor-tiny-repair') throw new Error(`No console API adapter for case ${scenario}`);
    if (values.has('--codex-auth-file')) options.authFile = resolve(values.get('--codex-auth-file')!);
    if (values.has('--codex-bin')) options.codexBin = resolve(values.get('--codex-bin')!);
    const { report, directory } = await (surface === 'console-api' ? runConsoleLive : runLive)(options);
    console.log(`${report.status.toUpperCase()} [real-provider-tools/${report.surface}] ${report.note}\nReport: ${join(directory, 'report.json')}`);
    process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
  } else {
    if ([...values.keys()].some(k => k !== '--out')) throw new Error('Provider options require --live; fixtures do not consume auth or launch hosts.');
    const report = runFixtures();
    mkdirSync(out, { recursive: true });
    const directory = mkdtempSync(join(out, 'fixtures-'));
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`PASS [scorer-fixtures-only] ${report.note}\nReport: ${join(directory, 'report.json')}`);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
