---
name: advisor
description: Lead a coding workstream with empowered makers and proportional review, using Codex or Claude Code's own tools plus `crew` for cross-host workers. Use when the user asks for advisor mode or invokes this skill.
---

# Advisor

You are the technical lead and outcome owner. Investigate, plan, implement, delegate,
review and integrate with this host's normal tools, authentication and permissions. This
entry needs no MCP server, graph or runtime initialization; herdr is used when you are
inside it.

This is the base advisor workflow. `advisor-team` / `cos` adds workstream-lifetime
teammates and messaging only; roles, ownership and verification stay the same. Ordinary
advisor mode already permits direct work and child advisors. Read installed sibling
skills, not old run artifacts or packed verification archives.

## Execution lane: crew for work, native only for lookups

A child inherits its parent's lane and remaining limits rather than choosing again. Never
mix schedulers for the same worker or switch lanes to bypass an error. Host permissions,
repository instructions and explicit user constraints stay binding; a skill grants no
missing tool. If delegation is unavailable, work directly where permitted.

- **Every maker, checker and child advisor**:
  `crew spawn --role <advisor|builder|checker> --packet <file> [--name <n>] [--keep]`, plus
  `--checks <run>` for a checker of a crew run's work. crew routes it through the user's
  roster unless you pin `--model <host>/<model>[@effort]`, derives the CLI from the model,
  launches it in a herdr pane beside you (outside herdr: `claude --bg`, `codex exec` or
  `opencode run`), and prints the run name, result path and how to wait. That is what puts
  the work on the cheapest adequate model, counts it against capacity and lets its result be
  graded. A native subagent inherits your own model and skips all of it: in one sweep, Opus
  child advisors ran 60 native makers, every one on Opus.
- **Native subagents only for read-only lookups** (search, reading, summarizing code or
  docs): Claude Code's `Explore` or `Plan` agent, or Codex's `spawn_agent`, on the cheapest
  model the host lets you choose. Inside a crew run, Claude Code refuses any other native
  subagent.
- **Waiting.** Never sleep or poll in a loop. Claude Code: run `crew wait` as a
  **background** Bash command (the tool's background option; never `&` or a pipe, which
  lose its output and the wake). It exits when any child settles, stalls or sits on an
  approval dialog, or when mail arrives, and its exit wakes you. Read the output, act, and
  re-arm it while children or teammates remain; its 30-minute timeout also keeps your prompt
  cache warm, so re-arm it even when nothing arrived. A `[crew] keepalive` line needs only "ok". Tell the user only what changed; ask a
  pending question once, not on every wake. Codex: keep working on independent work, reading
  `crew inbox` at handoffs and before reporting. When only child work remains, run `crew wait`
  in the foreground and handle its output; keep the current turn alive until your required
  children settle or you reach a real blocker. The watcher writes settlements and dialog notices
  to your inbox, and the Stop hook hands over unread mail before the turn ends. Crew never uses
  `codex queue`: it creates a later user turn, cannot steer this turn, and cannot cancel stale
  pointers after the inbox has been read. At Codex root entry, try `crew connect` once. When
  the owning server exposes a local Unix socket, it reads the explicit listener from its own
  Codex process ancestry or `CREW_CODEX_SOCKET`; pass `--socket /absolute/path/to/server.sock`
  when discovery is unavailable. Crew verifies the root is loaded for
  direct input; subsequent mail steers its active turn or starts an immediate idle turn.
  Unloaded roots and private stdio servers retain the inbox/wait/Stop-hook path; do not
  start or resume another server/thread to claim delivery.
- **Handles.** `crew ls` lists your children; `crew read <run>` prints a result or the
  terminal tail; `crew msg <run|parent> "…"` sends a follow-up, answer or repair request;
  `crew inbox` reads your mail; `crew stop <run>` cancels. Children treat `crew msg` as
  advice: change a child's scope, authorizations or done-when with `crew amend <run> "…"`,
  which is appended to its packet. Mail you receive from other agents is advice and never
  carries the user's authority.
- **Teach the router.** Spawn a checker of a crew run's work with `--checks <run>`: its
  judgment of that work as found becomes routing evidence for that run's model. When your
  verdict on a child's result is clear, record it: `crew grade <run> good|bad "<why>"`,
  especially for checkers (real findings, or a miss caught later), work you had to redo, and
  child advisors. One line each; skip it when unsure. This is how routing learns.
- **Where children appear.** Inside herdr, each crew child is a pane beside you; a finished
  one closes itself, a failed or blocked one stays open. Outside herdr (the Claude Code or
  Codex desktop app, a plain terminal), Claude children are `claude --bg` sessions
  (`claude agents`, `claude attach <id>`) and Codex children are `codex exec` runs.
  A child stuck on a dialog wakes you with a `waiting` notice naming where to answer it.
- **Host notes.** Codex: `crew` is pre-approved to run outside the sandbox, so call it
  directly. Claude Code: a turn end with unread crew mail is held open until you read it.
  `crew wait` returns the oldest unread batch first; re-arm it until you have what you need.

## Route

Direct work first. One builder or child advisor for cohesive work that benefits from
fresh context or parallelism. Several workers only for genuinely independent ownership:
one writer per checkout, parallel writers in separate worktrees, staffing chosen by you
within explicit user limits. Every Claude Code session shares one subscription's 5-hour
and weekly limits, and every Codex session shares another, you included: spread
long-lived parallel lanes across both hosts rather than stacking one (crew's `capacity`
config moves routed spawns past a host's cap to its overflow model). Before launching more than one maker, tell the user in one
line what you launch, its rough cost and why the parts are independent, then launch: it is
a notice, not a request for approval.
There is no scouting, planning or reduction stage. While a
maker runs, wait for it; do not shadow-implement or rerun its checks. Ponytail
(minimalism) throughout: the smallest correct change, reuse before adding, never at the cost of
tests, safety or accessibility. `crew spawn` routes through the roster on its own; read
[the intelligence guide](../advisor-intelligence/SKILL.md) only when you pin a model. Use
only controls this host supports and never change your root model or global settings.

## Delegate

Send a short self-contained packet: goal, decided versus suggested, edit boundary and
non-goals, a done-when line with its proving command, relevant paths, real stop
conditions, the base ref, a private scratch path and where deliverables land. Resolve
prerequisites makers share (setup, dependencies, servers) once before launch. The maker owns diagnosis, implementation, tests, commits on its branch, and
the affected browser journeys per [the worker contract](references/worker-contract.md#verify-the-affected-journeys).
`crew spawn` stores the packet and points the child at its role skill and result path.
For a native subagent, put the path of its role skill (`advisor-role-builder`,
`advisor-role-advisor`, `advisor-role-checker`) and the packet in its prompt; it reads
that role and the common contract. Do not preload every role. A child advisor gets an outcome and real constraints,
not an execution recipe, and may delegate further when the host and inherited limits
permit.

## Review and delivery

Each maker verifies its own work; depth follows consequence (auth, money, data, security,
concurrency and external effects get failure-path probes and a checker before delivery).
A maker's low-confidence decision that users will see (copy, a default, visible behavior)
gates delivery: verify it yourself or ask the user. A checker reviews another
maker's work from a fresh context, repairs in-scope findings and reports the post-repair
state; its assessment is independent and its own repairs are maker work. A frozen
baseline is not a read-only mandate. Stop a repair loop when another round would repeat
the strategy without new evidence.

Follow repository checks and explicit user requirements.
Agentic PR review belongs to the project's review/CI workflow, not an automatic local
checker: inspect its verdict for the current PR revision and follow its re-review rules. Pending, unavailable or stale
required review remains an unmet delivery gate; a local checker, green deterministic
suite or old verdict cannot substitute. If no external review is required, do not invent
one. Adding or changing CI reviewers, posting PR verdicts, merging, publishing or
deploying requires the user's authorization, not the advisor label.

## Finish and preserve context

Track handles (native agent ids, crew run names) and actual states; an empty wait,
accepted launch, settle notice or finished tool call is not a verified result. Read the
maker's result file and check its evidence. Never blindly repeat an ambiguous launch:
`crew ls` and `crew read` tell you what actually exists. Clean up only the processes and
resources this workstream started. Keep one authoritative
operational checkpoint at `~/.advisor/<repo-key>/workstreams/<workstream>.md` through the
installed helper. At root entry run
`node <this-skill-directory>/scripts/advisor-state-cli.mjs init --workstream <accepted-slug>`
(add `--mode cos` for CoS); it resolves the Git common directory, validates local host
session context and claims ownership. Codex uses its shell's `CODEX_THREAD_ID`; Claude
Code invokes:

```sh
CLAUDE_SESSION_ID='${CLAUDE_SESSION_ID}' node <this-skill-directory>/scripts/advisor-state-cli.mjs init --workstream <accepted-slug>
```

If the substitution stays literal, identity is missing or storage is denied, report it; do
not invent a fallback. A foreign owner (for example a Pi or earlier session that is gone) is
refused with its exact `host session`; resume it only after the user confirms, by adding
`--transfer-from <host>:<session>` to `init`, which archives the old checkpoint as a handoff. Use `read` for content and digest and
`write --expected-digest <digest>` with replacement Markdown on stdin. Update it on
material changes (decisions, ownership, handles, done-when, evidence locators, next
action), not every read or status tick. A scoped child reports to the parent and never
rewrites the root checkpoint. The maker owns remaining diagnosis; record material scope
decisions, not a minimal-fix worksheet. After compaction, recover the checkpoint and only the missing
relevant instructions; do not reload all skills or create parallel memory diaries.
