#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { advisorIdentity, advisorStateRoot, nativeAdvisorIdentity, readAdvisorSession, claimAdvisorCheckpoint, readAdvisorCheckpoint, updateAdvisorCheckpoint } from './advisor-state.mjs';

export async function checkpointCommand(argv, env = process.env, input) {
  const [op, ...args] = argv;
  if (!['init', 'read', 'write'].includes(op) || args.length % 2) throw new Error('Usage: advisor-state-cli.mjs init|read|write [--cwd path] [--workstream slug] [--mode advisor|cos] [--expected-digest hash] [--transfer-from host:session]. write reads the checkpoint from stdin.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--cwd', '--workstream', '--mode', '--expected-digest', '--transfer-from'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate checkpoint option; owner/session/display overrides are not accepted.');
    options[key] = args[i + 1];
  }
  const identity = nativeAdvisorIdentity(env);
  const root = await advisorStateRoot(resolve(options['--cwd'] ?? process.cwd()));
  const prior = readAdvisorSession({ root, identity });
  const workstream = options['--workstream'] ?? prior?.workstream;
  const request = { root, identity, workstream };
  let value;
  // A transfer must name the exact current owner (the refusal prints it) and needs the user's go-ahead.
  let transferFrom;
  if (options['--transfer-from'] !== undefined) {
    if (op !== 'init') throw new Error('--transfer-from only applies to init');
    const at = options['--transfer-from'].indexOf(':');
    transferFrom = advisorIdentity(options['--transfer-from'].slice(0, at), options['--transfer-from'].slice(at + 1));
  }
  if (op === 'init') value = claimAdvisorCheckpoint({ ...request, workerHarness: 'native', mode: options['--mode'], ...(transferFrom ? { transferFrom } : {}) });
  else if (op === 'read') value = readAdvisorCheckpoint(request);
  else {
    let content = input;
    if (content === undefined) {
      content = readFileSync(0, 'utf8');
    }
    value = updateAdvisorCheckpoint({ ...request, content, expectedDigest: options['--expected-digest'] });
  }
  // Inside herdr, name the root advisor's pane after its workstream. Best effort, never fatal.
  if (op === 'init' && env.HERDR_ENV === '1' && env.HERDR_PANE_ID) {
    try {
      execFileSync(env.HERDR_BIN_PATH || 'herdr', [...(env.HERDR_SESSION ? ['--session', env.HERDR_SESSION] : []), 'pane', 'rename', env.HERDR_PANE_ID, `advisor · ${workstream}`], { stdio: 'ignore', timeout: 5000 });
    } catch { /* labels are cosmetic */ }
  }
  return { ...value, lane: 'unchanged', executionRuntimeStarted: false, identitySource: 'local trusted host context; not host-attested evidence' };
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await checkpointCommand(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
