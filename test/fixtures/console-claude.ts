/** Isolated stream-json peer. It never loads Claude state, credentials or a model. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.CLAUDE_FIXTURE_DIR!;
const mode = process.env.CLAUDE_FIXTURE_MODE;
const args = process.argv.slice(2);
const sessionId = args.find(a => a.startsWith('--session-id=') || a.startsWith('--resume='))!.split('=')[1]!;
writeFileSync(join(dir, 'launched.json'), JSON.stringify({ args, cwd: process.cwd(), sessionId,
  crewRun: process.env.CREW_RUN ?? null, config: process.env.CLAUDE_CONFIG_DIR, home: process.env.CREW_HOME,
  stateEvents: process.env.CLAUDE_CODE_SDK_READS_SESSION_STATE, inheritedAuth: process.env.ANTHROPIC_API_KEY ?? null }));
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
    output({ type: 'control_response', response: { subtype: mode === 'initialize-error' || subtype === 'interrupt' && mode === 'interrupt-error' ? 'error' : 'success',
      request_id: value.request_id, error: 'Fixture rejected control request', response: { commands: [] } } });
    if (subtype === 'initialize' && mode === 'identity-mismatch') output({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    if (subtype === 'interrupt' && mode !== 'interrupt-delay' && mode !== 'interrupt-error') setTimeout(result, 20);
  } else if (value.type === 'user') {
    output({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sessionId });
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
