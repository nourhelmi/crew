# crew

Advisor crews on the **native** harnesses: Claude Code for Anthropic models, Codex for OpenAI
models. No Pi, no runtime service, no database. The advisor doctrine lives in skills.
One small CLI does the three things the hosts don't do across each other:

| Primitive | How |
|---|---|
| **spawn** | `crew spawn` routes the task through Jev (`agent-router`) unless you pin `--model`. The model decides the CLI: `anthropic/`, `claude-*` and `opus` run in Claude Code; `openai/`, `gpt-*` run in Codex. Inside herdr the child gets a pane beside you; outside, `claude --bg` or `codex exec`. |
| **wake** | Children write `result.md`. The parent is woken by: its background `crew wait` exiting (Claude Code); a push into its thread via `codex queue` (Codex); or an idle-herdr-pane pointer. The child's Stop hook settles it, and the parent's sweep settles anything the hook missed. |
| **message** | `crew msg <run\|name\|parent\|mailbox>`. The file inbox is the source of truth, and pushes only wake the recipient. Any session with unread mail is held open at turn end until it has read it. |

Same-host, short-lived makers still use the host's own subagents: Claude's `Agent` tool
with the `advisor-maker` agent type, and Codex's `spawn_agent` with the `advisor-maker` role.
Hooks inject the result path and refuse to let a maker stop before its result is terminal.

## Install

```sh
npm install              # dev only: typescript for `npm run typecheck`
node scripts/install.ts  # idempotent; backs up every file it edits to ~/.crew/backups/
```

The installer:

- links `~/.local/bin/crew`
- installs the `crew` plugin in Claude Code and in Codex, from this repo as a local marketplace
- links the Codex `advisor-maker` role
- clears the old pi-meta-harness skill links and trace hooks
- turns Claude background tasks back on
- pre-approves `crew` in Codex (`~/.codex/rules/crew.rules`) and makes `~/.crew` writable in its sandbox
- trusts every checkout under `~/Dev` in both CLIs, with zsh `claude`/`codex` wrappers and a launchd sweep every 10 minutes so new checkouts never prompt

After changing skills or hooks, bump `version` in both plugin manifests and re-run the installer.
The CLI itself is always the live checkout: plugin-cached copies delegate to `~/.local/bin/crew`.

## Use

In any Claude Code session (CLI or desktop app) or Codex session (CLI or app): `/advisor`
or `/cos` (`$advisor` / `$cos` in Codex). The skills tell the advisor when to work directly,
when to use a native subagent, and when to `crew spawn`.

```sh
crew spawn --role builder --packet packet.md --name api     # Jev picks the model and CLI
crew spawn --role checker --model gpt-6-sol@xhigh --task "…"  # pinned
crew spawn --role advisor --keep --name billing --packet p.md # a CoS teammate
crew wait                 # Claude: run in the background; exits on settle/stall/waiting/mail
crew msg billing "…"      # follow-up, answer, new assignment (--file for long ones)
crew inbox | crew ls | crew read api | crew stop api
crew route --role builder --task "…"   # where would this go?
crew trust --all          # re-trust checkouts under ~/Dev
```

## Config: `~/.config/crew/config.json`

- `defaults`: the model per role when Jev is off or fails (`model@effort`).
- `router`: the `agent-router` command, `enabled` and `timeoutMs`.
- `args`: extra CLI args per host. The default is `--permission-mode auto` for Claude children.
  Codex children inherit your Codex config. Put any bypass flags here yourself.
- `trust.roots`: default `["~/Dev"]`.

## State: `~/.crew`

- `runs/<id>/`: `meta.json`, `packet.md`, `result.md`, and `exec.log` for `codex exec` children.
- `mail/<mailbox>/`: `inbox.jsonl`, a read `cursor`, and `waiter.pid` while a `crew wait` is armed.

Mailboxes are the run id for crew children, `claude-<session id>` for Claude roots and
`codex-<thread id>` for Codex roots.

## Notes

- Codex sandbox (`workspace-write`) keeps `.git` read-only. Spawn grants the checkout's git
  dir and `~/.crew` as writable roots, so builders commit without an escalation.
- Messages Codex→Claude to an idle Claude session outside herdr wait until that session's
  next turn or armed `crew wait`. Claude Code channels could push them, but they're a
  research preview and aren't used.
- `codex queue` wakes an idle Codex TUI thread (verified). A `codex exec` child can't take
  mid-run mail; use a herdr pane or `--keep` for anything you'll talk to.

## Test

```sh
npm test && npm run typecheck
```
