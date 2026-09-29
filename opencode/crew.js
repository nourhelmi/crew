// crew for OpenCode: crew's hooks, identity and wakes. Installed by crew's scripts/install.ts as a
// link in ~/.config/opencode/plugins; edit the copy in the crew repo.
//
// OpenCode has plugin events where Claude Code and Codex have hooks, so this maps them:
//   session.created    -> crew hook session-start (a crew child records its session)
//   session.idle       -> crew hook stop (settle a finished child, surface unread mail; a "block"
//                         becomes a follow-up prompt, like a blocked Stop hook)
//   tool.execute.after -> crew hook post-tool (a crew child hears about new mail mid-turn)
//   shell.env          -> CREW_OPENCODE_SESSION, so `crew` knows which session is calling
// OpenCode's TUI serves no port, so nothing outside can push into a session. Instead this plugin
// watches its own sessions' crew inboxes and wakes an idle session when mail lands, the way
// `codex queue` does for Codex. Subagent sessions (those with a parent) are left alone.
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREW = process.env.CREW_BIN || join(homedir(), '.local', 'bin', 'crew');
const HOME = process.env.CREW_HOME || join(homedir(), '.crew');
const POLL_MS = Number(process.env.CREW_OPENCODE_POLL_MS) || 3000;
const WAKE = '[crew] new crew mail. Run: crew inbox';

/** Run a crew hook with its JSON payload on stdin; resolves to the parsed output, or undefined. */
function hook(event, payload) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(CREW, ['hook', event, '--host', 'opencode'], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(undefined));
    child.on('close', () => { try { resolve(out.trim() ? JSON.parse(out) : undefined); } catch { resolve(undefined); } });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Bytes of crew mail past the read cursor (crew's own definition of unread). */
function unreadBytes(mailbox) {
  const dir = join(HOME, 'mail', mailbox.replace(/[^a-zA-Z0-9._-]/g, '_'));
  let size = 0, cursor = 0;
  try { size = statSync(join(dir, 'inbox.jsonl')).size; } catch { return 0; }
  try { cursor = Number(readFileSync(join(dir, 'cursor'), 'utf8')) || 0; } catch { /* nothing read yet */ }
  return size > cursor ? size : 0;
}

export const CrewPlugin = async ({ client }) => {
  const run = process.env.CREW_RUN;
  const subagents = new Set();
  const continued = new Set(); // sessions we just kept going after a blocked turn end
  const sessions = new Map();  // top-level session -> { mailbox, idle, woke: inbox size last woken for }
  const prompt = (id, text) => {
    const body = { path: { id }, body: { parts: [{ type: 'text', text }] } };
    return client.session.promptAsync ? client.session.promptAsync(body) : client.session.prompt(body);
  };
  const track = id => {
    let mailbox = `opencode-${id}`;
    if (run) {
      try {
        const meta = JSON.parse(readFileSync(join(HOME, 'runs', run, 'meta.json'), 'utf8'));
        if (!meta.sessionId || meta.sessionId === id) mailbox = run;
      } catch { /* a missing/inherited run is not this session */ }
    }
    if (!sessions.has(id)) sessions.set(id, { mailbox, idle: true, woke: 0 });
    else sessions.get(id).mailbox = mailbox;
    return sessions.get(id);
  };

  const wakeIdle = async () => {
    for (const [id, s] of sessions) {
      const unread = s.idle ? unreadBytes(s.mailbox) : 0;
      if (!unread || unread === s.woke) continue;
      s.woke = unread; s.idle = false;
      await prompt(id, WAKE).catch(() => { s.idle = true; s.woke = 0; });
    }
  };
  const timer = setInterval(() => { wakeIdle().catch(() => {}); }, POLL_MS);
  timer.unref?.();

  return {
    'shell.env': async (input, output) => {
      if (!input.sessionID || subagents.has(input.sessionID)) return;
      output.env.CREW_OPENCODE_SESSION = input.sessionID;
    },

    event: async ({ event }) => {
      const props = event.properties ?? {};
      if (event.type === 'session.created') {
        if (props.info?.parentID) { subagents.add(props.info.id); return; }
        if (!props.info?.id) return;
        track(props.info.id);
        if (run) await hook('session-start', { session_id: props.info.id });
        return;
      }
      if (event.type === 'session.status' && props.sessionID && sessions.has(props.sessionID)) {
        const kind = typeof props.status === 'string' ? props.status : props.status?.type;
        if (kind) sessions.get(props.sessionID).idle = kind === 'idle';
        return;
      }
      if (event.type !== 'session.idle' || !props.sessionID || subagents.has(props.sessionID)) return;
      const id = props.sessionID;
      const s = track(id);
      s.idle = true;
      const out = await hook('stop', { session_id: id, stop_hook_active: continued.delete(id) });
      if (out?.decision !== 'block' || !out.reason) return;
      continued.add(id);
      s.idle = false;
      await prompt(id, out.reason);
    },

    'tool.execute.after': async (input, output) => {
      if (!run || subagents.has(input.sessionID)) return;
      const context = (await hook('post-tool', { session_id: input.sessionID }))?.hookSpecificOutput?.additionalContext;
      if (context) output.output = `${output.output ?? ''}\n\n${context}`;
    },
  };
};
