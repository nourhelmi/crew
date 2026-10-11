/** Isolated stream-json peer. It never loads Claude state, credentials or a model. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { self } from '../../src/identity.ts';

const dir = process.env.CLAUDE_FIXTURE_DIR!;
const mode = process.env.CLAUDE_FIXTURE_MODE;
const args = process.argv.slice(2);
const sessionId = args.find(a => a.startsWith('--session-id=') || a.startsWith('--resume='))!.split('=')[1]!;
writeFileSync(join(dir, 'launched.json'), JSON.stringify({ args, cwd: process.cwd(), sessionId, pid: process.pid,
  crewRun: process.env.CREW_RUN ?? null, config: process.env.CLAUDE_CONFIG_DIR, home: process.env.CREW_HOME,
  stateEvents: process.env.CLAUDE_CODE_SDK_READS_SESSION_STATE, inheritedAuth: process.env.ANTHROPIC_API_KEY ?? null,
  claudeSession: process.env.CLAUDE_SESSION_ID, claudeCodeSession: process.env.CLAUDE_CODE_SESSION_ID,
  crewMailbox: process.env.CREW_MAILBOX, codexThread: process.env.CODEX_THREAD_ID ?? null,
  opencodeSession: process.env.CREW_OPENCODE_SESSION ?? null }));
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const result = () => {
  output({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false, result: 'Finished' });
  output({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: sessionId });
};
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  appendFileSync(join(dir, 'input.ndjson'), line + '\n');
  if (value.type === 'control_request') {
    const subtype = value.request.subtype;
    if (subtype === 'initialize' && mode === 'initialize-disconnect') { process.exit(7); }
    if (subtype === 'initialize' && mode === 'workflow') {
      const helper = fileURLToPath(new URL('../../skills/advisor/scripts/advisor-state-cli.mjs', import.meta.url));
      const checkpoint = JSON.parse(execFileSync(process.execPath, [helper, 'init', '--cwd', dir, '--workstream', 'fixture', '--mode', 'cos'], { encoding: 'utf8', timeout: 5000 }));
      writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ identity: checkpoint.identity, paths: checkpoint.paths, caller: self() }));
    }
    output({ type: 'control_response', response: { subtype: mode === 'initialize-error' || subtype === 'interrupt' && mode === 'interrupt-error' ? 'error' : 'success',
      request_id: value.request_id, error: 'Fixture rejected control request', response: { commands: [] } } });
    if (subtype === 'initialize' && mode === 'identity-mismatch') output({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    if (subtype === 'interrupt' && mode !== 'interrupt-delay' && mode !== 'interrupt-error') setTimeout(result, 20);
  } else if (value.type === 'user') {
    output({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sessionId });
    if (mode === 'send-disconnect-before-ack') process.exit(9);
    if (mode !== 'no-user-ack') output(value);
    if (mode === 'send-disconnect') process.exit(9);
  }
});
let offset = 0;
setInterval(() => {
  const lines = readFileSync(join(dir, 'output.ndjson'), 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(offset)) {
    const command = JSON.parse(line);
    if (command.fixture === 'exit') process.exit(command.code ?? 0);
    if (command.fixture === 'end') { process.stdout.end(); continue; }
    if (command.fixture === 'result') { result(); continue; }
    if (command.fixture === 'raw') { process.stdout.write(command.text); continue; }
    output({ session_id: sessionId, ...command });
  }
  offset = lines.length;
}, 5);
