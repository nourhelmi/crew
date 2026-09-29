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
| context or follow-up (advice) | `crew msg <name> "…"` or `--file <file>` |
| change scope, authorization or done-when, or assign a distinct outcome | `crew amend <name> "…"` or `--file <new-packet>`: appended to its packet; the teammate rewrites its result.md for a new outcome |
| judge a delivered outcome (routing learns from it) | `crew grade <name> good\|bad "<why>"` |
| rename | not supported; retire and enlist under the new name |
| retire | tell it to settle its own children, wait for its settle notice, then `crew stop <name>` |

Messages are advice: they never grant scope, assign work or certify completion. Scope,
authorizations and done-when change only by `crew amend`, which becomes part of the
packet; decide them up front where you can. A follow-up message to the same member handles
same-outcome repair; an amended packet is for a genuinely distinct outcome. A teammate that
must end a turn mid-assignment writes `IN PROGRESS: <next step>`, which wakes no one and
keeps it going; if it stops on that twice you get a `waiting` notice. One maker per checkout still applies. A teammate's `crew msg parent`
reaches the root; it can reach a sibling by name.

Keep `crew wait` armed while teammates are alive (in Claude Code, as a background
command). That is how their reports and messages wake you. Teammates wake the same way:
a headless teammate resumes its recorded session to read its inbox, and an idle
teammate in herdr gets a one-line pointer typed into its pane, one per unread batch; a busy teammate is
told about unread mail after its next tool call. Any session with unread mail is kept
going at its next turn end until it has read it.

Retire members before closing a team; retirement waits for real descendant settlement.
Sent or queued is not read or done, so never resend an ambiguous message as a new one.
`crew msg` prints how it was delivered: `waiter`, `codex-queue`, `opencode-plugin`, `herdr-prompt`, `headless-resume` or
`queued`. `headless-resume` means a resume request was scheduled; it does not prove the mail was read.
`crew resume <run>` explicitly resumes an exited headless session with its recorded model and access.
A fresh maker can also continue from files: give `crew spawn --packet` a continuation packet
naming the checkpoint, previous packet/result, verified state and remaining done-when. Retire
the previous writer before handing off the checkout. Verify the evidence rather than assuming
its prior conversation was complete. A stopped run stays stopped; assign new work with a fresh spawn. `queued` means the recipient sees it at its next wait, inbox read or turn end.

Root and CoS share one checkpoint at `~/.advisor/<repo-key>/workstreams/<slug>.md`. The
root updates it; helpers report locators. `crew ls` is a projection, not a second
scheduler.
