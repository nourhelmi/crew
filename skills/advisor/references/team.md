# CoS teams

Teammates are child advisors kept for the workstream's lifetime. Each session belongs to
exactly one workstream and is never adopted by, renamed into or imported from another.
Work directly, launch temporary roles, or enlist a teammate with
`crew spawn --role advisor --keep --name <name> --packet <file>`. Jev routes each teammate
to its own model, so one team can mix Claude Code and Codex sessions. The mechanics work
the same either way:

| Team operation | crew |
|---|---|
| enlist | `crew spawn --role advisor --keep --name <name> --packet <file>` |
| status / roster | `crew ls` (state, model, last reported status) |
| message a teammate, or the root | `crew msg <name|parent> "…"` or `--file <file>` |
| context or assign a distinct outcome | `crew msg <name> --file <new-packet>`; the teammate rewrites its result.md for it |
| rename | not supported; retire and enlist under the new name |
| retire | tell it to settle its own children, wait for its settle notice, then `crew stop <name>` |

Messages are advice: they never grant scope, assign work or certify completion. A follow-up
message to the same member handles same-outcome repair; a new packet is for a genuinely
distinct outcome. One maker per checkout still applies. A teammate's `crew msg parent`
reaches the root; it can reach a sibling by name.

Keep `crew wait` armed while teammates are alive (in Claude Code, as a background
command). That is how their reports and messages wake you. Teammates wake the same way:
an idle Codex teammate gets mail pushed into its thread, and an idle Claude teammate in
herdr gets a one-line pointer to run `crew inbox`. Any session with unread mail is kept
going at its next turn end until it has read it.

Retire members before closing a team; retirement waits for real descendant settlement.
Sent or queued is not read or done, so never resend an ambiguous message as a new one.
`crew msg` prints how it was delivered: `waiter`, `codex-queue`, `herdr-prompt` or
`queued`. `queued` means the recipient sees it at its next wait, inbox read or turn end.

Root and CoS share one checkpoint at `~/.advisor/<repo-key>/workstreams/<slug>.md`. The
root updates it; helpers report locators. `crew ls` is a projection, not a second
scheduler.
