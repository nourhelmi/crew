# crew

**An advisor-led engineering team on the harnesses you already use.** Claude Code runs the
Anthropic models, Codex runs the OpenAI models, and a tiny CLI lets them spawn, wake and
message each other across hosts. There's no orchestration runtime, no daemon and no database.

```
you ─▶ /crew:advisor "ship the billing migration"
        │  (Claude Code, Opus)
        ├─ crew spawn --role builder   ──▶  Codex pane · GPT   ─┐
        ├─ crew spawn --role checker   ──▶  Codex pane · GPT   ─┤ result.md ─▶ wakes the advisor
        └─ crew spawn --role advisor --keep ─▶ Claude pane · Opus ┘ (a CoS teammate you can message)
```

## Why

Multi-agent setups tend to grow a runtime: a scheduler, delivery acks, leases, a database,
background services. Then the runtime becomes the product. The native harnesses already have
most of what's needed:

- **Claude Code** re-invokes an idle session when a background command exits, has subagents and
  hooks, and loads skills from plugins.
- **Codex** has subagents, hooks, plugins, and `codex queue`, which starts a turn in an idle thread.
- **herdr** gives agents visible panes and lifecycle state.

What's missing is the glue *between* hosts. crew is that glue: about 1,400 lines of
dependency-free TypeScript, plus plain files in `~/.crew`.

| Primitive | How crew does it |
|---|---|
| **Spawn** | `crew spawn` picks a model (pinned, a pluggable router, or role defaults), and **the model decides the CLI**. Inside herdr the child opens in a pane beside you; outside, it runs as `claude --bg` or `codex exec`. |
| **Wake** | The child writes `result.md`, and its Stop hook settles it to the parent. The parent is woken natively: its background `crew wait` exits in Claude Code, `codex queue` pushes into its thread in Codex, or an idle herdr pane gets a one-line pointer. The parent also sweeps for children whose hooks never ran. |
| **Message** | `crew msg <name\|parent\|run>` writes to a file inbox (the source of truth), then pushes the same wake. A session with unread mail is held open at turn end until it has read it. |

Same-host, short-lived makers use the host's own subagents: Claude's `Agent` tool and Codex's
`spawn_agent`, both with an `advisor-maker` agent that must write a terminal result before stopping.

## The workflow

The skills carry the doctrine; crew only moves work between hosts.

- **Advisor.** The technical lead and outcome owner. It works directly first, delegates cohesive
  work with a short packet (goal, decided vs suggested, edit boundary, done-when with a proving
  command), and keeps one checkpoint per workstream. Review depth follows consequence.
- **Builder.** Owns investigation, implementation, tests, commits and browser checks of the
  affected journeys, end to end.
- **Checker.** A fresh-context review that *repairs* in-scope findings and reports the state after repair.
- **Child advisor.** The same judgment, scoped to the parent's outcome. It may delegate further
  and must settle its children before returning.
- **CoS (chief of staff).** An additive overlay in which kept child advisors act as teammates for
  the life of the workstream. They message each other and the root, whichever CLI each one runs on.

Every maker returns a `result.md` with `Status / Claims / Evidence / Files / Decisions / Remaining Risk`,
where the first line under Status is `DONE`, `PASS`, `FAIL` or `BLOCKED: <reason>`.

## Requirements

- macOS or Linux, and Node.js ≥ 24 (crew runs its TypeScript directly)
- [Claude Code](https://code.claude.com) and/or the [Codex CLI](https://github.com/openai/codex), logged in
- Optional: [herdr](https://herdr.dev) for visible panes
- Optional: [agent-router](https://github.com/nourhelmi/agent-router) for task-fit model routing
  with [TypeSafe](https://typesafe.ai)'s Jev

## Install

```sh
git clone https://github.com/nourhelmi/crew ~/crew && cd ~/crew
node scripts/install.ts                       # add --trust-root ~/code to skip folder-trust dialogs there
```

The installer is idempotent, and it backs up every file it touches to `~/.crew/backups/`. It:

- links `~/.local/bin/crew`
- installs the `crew` plugin into Claude Code and Codex, using this repo as a local marketplace
- links the Codex `advisor-maker` role
- pre-approves `crew` in Codex (`~/.codex/rules/crew.rules`) and makes `~/.crew` writable in its sandbox
- removes `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` from Claude settings, since background tasks are how Claude parents wake

Codex asks you once to review crew's hooks (`/hooks`, then trust). The hook commands are
version-stable, so upgrades don't ask again.

**`--trust-root <dir>`** (opt-in, repeatable): neither CLI inherits folder trust across git
roots, so a new checkout or worktree shows a trust dialog. That dialog silently blocks a spawned
agent. With a trust root, crew trusts every checkout under it in both CLIs, adds `claude`/`codex`
shell wrappers for new ones, and re-sweeps every 10 minutes (launchd). Only point it at code you trust.

## Use

| Host | Advisor | CoS team |
|---|---|---|
| Claude Code (CLI or desktop) | `/crew:advisor …` | `/crew:cos …` |
| Codex (CLI or app) | `$advisor …` | `$cos …` |

> In Claude Code, `/advisor` on its own is a built-in command. Use `/crew:advisor`.

The advisor decides when to delegate. You can also drive crew by hand:

```sh
crew spawn --role builder --packet packet.md --name api       # routed: model → CLI
crew spawn --role checker --model gpt-6-sol@xhigh -- "review the auth diff"
crew spawn --role advisor --keep --name billing --packet p.md # a CoS teammate
crew wait                  # blocks until a child settles/stalls/needs a dialog, or mail arrives
crew msg billing "…"       # follow-up, answer, or a new assignment (--file for long ones)
crew inbox · crew ls · crew read api · crew stop api
crew route --role builder --task "…"                           # where would this go?
```

In Claude Code, run `crew wait` as a **background** command: its exit wakes the session. In
Codex, mail and settlements are pushed into your thread, so keep working or end your turn.

## Routing

`crew spawn` without `--model` asks the configured router with
`route --file - --dry-run` and the payload `{ role, task, harness: "native" }`, and reads
`selected.model` / `selected.thinking` from the reply. It uses
[agent-router](https://github.com/nourhelmi/agent-router) by default, and any command that
follows that contract works. If no router is installed or it fails, spawn uses the role
defaults. Model ids map to CLIs by provider:

- `anthropic/…`, `claude-bridge/…`, `claude-*` and `opus`/`sonnet` run in **Claude Code**
- `openai/…`, `openai-codex/…` and `gpt-*` run in **Codex**

Efforts a CLI lacks are clamped (Codex `max` becomes `xhigh`).

To turn routing off, use `crew router off` for the current session (every child it spawns
inherits the setting), `crew router off --global` for the config, or `CREW_ROUTER=off` in the
environment, which beats both. `crew router status` shows which one applies. With routing
off, spawns use the role `defaults`, and `--model` still pins. Intelligence profiles
(`skills/advisor-intelligence/profiles`) describe which model fits which role.

## Configuration: `~/.config/crew/config.json`

```json
{
  "defaults": { "advisor": "claude-opus-5-5@high", "builder": "gpt-6-sol@high", "checker": "gpt-6-sol@xhigh" },
  "router":   { "enabled": true, "command": "agent-router", "timeoutMs": 90000 },
  "args":     { "claude": ["--permission-mode", "auto"], "codex": [] },
  "trust":    { "roots": [] }
}
```

`args` are appended to every child of that host. Codex children otherwise inherit your Codex
config (approvals and sandbox). crew never adds bypass flags; put them in `args` if you want them.

## How it holds up

- **State** is files: `~/.crew/runs/<id>/{meta.json, packet.md, result.md}` and
  `~/.crew/mail/<mailbox>/inbox.jsonl` plus a read cursor. Races between a child's hook and the
  parent's sweep are settled by exclusive-create claim files, and launchers merge into live
  metadata instead of overwriting it.
- **Identity**: crew children are their run id, Claude roots are `claude-<CLAUDE_CODE_SESSION_ID>`,
  and Codex roots are `codex-<CODEX_THREAD_ID>`.
- **Sandboxes**: Codex's `workspace-write` keeps `.git` read-only, so spawn grants the checkout's
  git dir and `~/.crew` as writable roots, and builders commit without an escalation. Claude
  children get the same dirs, plus crew's skills, via `--add-dir`.
- **herdr**: every call is pinned to the session the run was spawned in, and agents are addressed
  by pane. Finished children close their own pane; failed or blocked ones stay open.
- **Dialogs**: a child stuck on an approval, question or trust dialog wakes its parent with a
  `waiting` notice that says where to answer it.

Verified end to end on Claude Code 2.1.280 and Codex 0.157:

- Claude↔Codex spawns in every direction, through herdr panes, `claude --bg` and `codex exec`
- native background wake
- `codex queue` waking an idle thread
- a kept CoS teammate taking a second assignment by message

## Limitations

- A message from Codex to an *idle* Claude session outside herdr waits for that session's next
  `crew wait` or turn. Claude Code "channels" could push it, but they're a research preview.
- A `codex exec` child can't take mail mid-run. Use herdr, or `--keep`, for anything you'll talk to.
- Hooks are the fast path; the parent's sweep is the backstop. If you disable both, nothing settles.

## Development

```sh
npm install        # typescript, for the typecheck only
npm test && npm run typecheck
node scripts/install.ts   # after changing skills or hooks, bump `version` in both plugin manifests first
```

See [AGENTS.md](AGENTS.md) for the invariants.

## License

[MIT](LICENSE) © Nour Helmi
