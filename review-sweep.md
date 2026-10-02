# Crew lifecycle review and implementation — 2026-09-30

Historical implementation: **Crew 0.11.0**, installed in the local Claude Code and Codex plugin caches. Default launches remain fresh runs. Retained headless sessions have an optional, serialized resume path. The original retained-worker, liveness and settlement-delivery findings were addressed; the root Codex queue transport needed a further correction, recorded below.

Baseline: `a3d5c5f` (0.10.6), initially clean. This review covers the 0.11.0 lifecycle changes. Runtime dependencies remain zero. Hook command strings were preserved, so their existing Codex trust hashes remain valid.

## Workflow and continuity

An advisor can launch a fresh maker with a continuation packet naming the checkpoint, previous packet/result, verified state and remaining done-when. `crew spawn --packet continuation.md` creates a new run, session and result. Previous maker artifacts remain available. Packets, results, run metadata and mail are persisted. The advisor maintains its checkpoint through the workflow; Crew does not automatically turn every thought or chat message into a checkpoint. Conversation history is optional; the advisor must still verify evidence and retire the prior writer before handing off a checkout.

For retained teammates, amendments and mail schedule a headless resume. `crew resume <run>` provides explicit recovery. Resumes preserve the recorded session, route, launch inputs and host homes; they do not reroute. Busy or uninspectable workers are left alone. An explicitly stopped Crew run stays stopped; fresh work uses a new spawn.

Claude background resumption needs special handling: `--bg` owns its UUID and ignores `--session-id`; an idle background TUI may still be alive. Crew reads the specific launch receipt and corroborates immutable identity, stops only a positively idle owned worker, confirms absence using the active-only listing, and resumes the full session UUID without additional launch flags. Claude restores its saved settings. An unexpected copy is stopped and reported.

## Repairs and evidence

| Failure | Implemented behavior | Verification |
|---|---|---|
| Finished headless workers cannot take another assignment | Same-session Codex/OpenCode exec resume; Claude background stop/restore; optional `crew resume` | All host shims; real Codex resume; live Claude checks below |
| Concurrent wake/resume requests create duplicate turns | Cross-process resume mutex, turn generation, one attempted launch per mail batch | Concurrent CLI requests; failed-turn recovery |
| Resume failure silently loops forever | Failed launch/turn reports stalled; new mail or explicit resume can retry | Exited exec and inactive Claude fixtures |
| Liveness command failure looks like worker death | Unavailable/malformed lookup stays unknown; only confirmed absence/exits stall | Herdr and Claude transport/malformed/absence fixtures |
| Intentional restart gap looks like death | Watcher defers liveness while the resume mutex is held | Relaunch-gap fixture |
| Claude lookup selects a reused name | Lookup, stop and resume use immutable IDs | Same-name foreign session and unexpected-copy checks |
| Watcher uses another caller's host configuration | Record host homes and use them for lookup, launch, logs and stop | Host-home isolation fixture; live isolated host state |
| GUI/background shell cannot find Node, especially with forced colour | Record `CREW_NODE`; launcher validates the exit code rather than coloured `node -p` output | No-Node-PATH/forced-colour fixture; live Claude hooks |
| Trust targets wrong host state | Honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME` | Isolated trust files and real temporary workspace |
| Crash after settlement loses parent notice | Claim contains durable outbox; append-once replay; flush even after a newer draft | Recovery before metadata, after append, after consumption and after a new draft |
| External router delays settlement delivery | Deliver and acknowledge the notice before best-effort grading | Settlement ordering and existing grading checks |
| Mail wake races ahead of inbox append | Persist first; serialize delivery and batch wake coverage | Immediate-reader and simultaneous-sender fixtures |
| Metadata writers lose independent fields | Lock and merge into current run metadata | Two competing Node processes |
| Inbox cursor rewinds or two readers replay a batch | Monotonic cursor and serialized consumption, including truncation | Stale reader, concurrent CLI readers, truncated inbox |
| Old DONE satisfies unread/consumed amendment | Require fresh result hash after each amendment | Amendment freshness and exited-worker checks |
| Fast launch overwrites child-owned metadata | Merge launcher fields into live metadata | Hook/launcher race and Herdr closure fixtures |
| Stop resurrects a run or leaves exec descendants alive | Stop wins over settlement/resume; signal owned process group | Stop/late-result and descendant checks |
| Pane closure is acknowledged before it succeeds | Parent watcher confirms lookup/close and retries transport failure | Close-retry and real CLI fixture journey |
| Explicit stop hides host errors | Preserve stop intent and report unconfirmed host stop; allow retry | Herdr and Claude stop-failure fixtures |
| Concurrent routed spawns reuse name/capacity | Reserve after asynchronous routing under spawn lock | Same-name and capacity fan-out fixtures |
| Missing executable creates unhandled async error | Await spawn/error; mark failure; close log descriptor | Missing executable fixture |
| OpenCode sees foreign run mail or never retries wake | Bind mailbox to session ownership; retry rejected prompt | Plugin fixtures |
| Keepalive fires every sweep | Space by last successful nudge | Cold transcript fixture |
| CoS documentation promises suppressed Codex queue wake | Root-only queue; headless resume and fresh checkpoint handoff documented | Updated installed team guide |

## Verification

- `npm test`: **126 passed, 0 failed, 0 skipped**. Host tests use temporary Crew/host homes and executable shims, never personal host state.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Installer ran successfully; both host caches contain version 0.11.0 and the updated team guide. Hook command strings are unchanged.
- Real Codex: initial launch, terminal result, amendment, same-thread resume, second result, cross-host messaging and parent notices.
- Real Claude Code and Codex: direct messages in both directions, consumed by the actual recipient and reflected in terminal results.
- Fresh maker: a different Codex run/thread continued from a checkpoint and predecessor artifact files.
- Live Herdr multiplexer was not exercised; its CLI lifecycle was tested through an isolated executable fixture.
- OpenCode executable is absent locally; plugin and headless lifecycle paths were tested through fixtures. Resume uses the documented [`opencode run --session`](https://dev.opencode.ai/docs/cli/) interface.

A successful wake request is not proof of consumption or completion. The live claims below require actual inbox messages and terminal results. Result freshness also does not independently judge acceptance criteria; the advisor/checker owns that review.

## Live evidence

Codex retained run: `b-8ho6a854c`, thread `01a0ef3b-b96e-7d33-98f3-49d5ea93443d`.

Initial result: `DONE: RESUME-PHASE-1`. After amendment and resume: `DONE: RESUME-PHASE-2`, with `RESUMED-SAME-SESSION-OK`, retaining that thread ID.

Claude run: `b-8z953c707`, session `81bd25fb-57c3-4c20-86c7-c23e20147a39`. Same-session continuation completed with `DONE: CLAUDE-RESUMED` and `SAME-CLAUDE-SESSION-OK`.

Observed direct exchange:

```text
Codex → Claude: CROSS-CODEX-TO-CLAUDE
Claude → Codex: CROSS-CLAUDE-TO-CODEX
Claude result: DONE: CROSS-HOST-CLAUDE
Codex result: DONE: CROSS-HOST-CODEX

Claude → Codex: CROSS-CLAUDE-INITIATED
Codex → Claude: CROSS-CODEX-REPLY
Claude result: DONE: REVERSE-CLAUDE
Codex result: DONE: REVERSE-CODEX
```

Both initiating directions were exercised against the real hosts. The second exchange was triggered by amendments to completed retained runs, automatically restoring each original session ID.

Fresh continuation: `b-92yia3444`, thread `01a0ef4a-e15b-7fd2-9386-5b0904b156cc`, result `DONE: FRESH-CHECKPOINT-CONTINUATION` with `CONTINUED-FROM-FILES`. Its packet names the checkpoint and predecessor result artifacts.

The live tests exposed and repaired assumptions that shims initially missed: Claude-managed IDs, forced-colour Node detection, completed background rows that retain `done` after stop, host-home lookup and native saved-option resume semantics. Isolated credential continuity is part of the test harness: existing credentials are read-only, private temporary copies/settings are removed after capture, and no credentials are included in evidence or Crew metadata. The first nested Codex sandbox launch from the initial review was blocked; live retry retained child workspace sandboxing and used authorized orchestration outside the parent sandbox. No permission or hook-trust bypass flags were used.

Evidence directory: [/tmp/crew-resume-evidence](/tmp/crew-resume-evidence).

- [Final suite](/tmp/crew-sweep-final-complete.log)
- [Install log](/tmp/crew-sweep-install.log)
- [First-phase metadata](/tmp/crew-resume-evidence/phase1-meta.json)
- [Direct cross-host messages](/tmp/crew-resume-evidence/cross-direct-mail.json)
- [Cross-host Codex result](/tmp/crew-resume-evidence/cross-codex-result.md)
- [Cross-host Claude result](/tmp/crew-resume-evidence/cross-claude-result.md)

- [Claude same-session continuation](/tmp/crew-resume-evidence/claude-resumed-result.md)
- [Reverse direct messages](/tmp/crew-resume-evidence/reverse-direct-mail.json)
- [Reverse Codex result](/tmp/crew-resume-evidence/reverse-codex-result.md)
- [Reverse Claude result](/tmp/crew-resume-evidence/reverse-claude-result.md)
- [Fresh maker continuation](/tmp/crew-resume-evidence/fresh-checkpoint-result.md)
- [Parent inbox consumption](/tmp/crew-resume-evidence/parent-inbox.log)
- [Owned process and credential cleanup](/tmp/crew-resume-evidence/cleanup.log)

The installer intentionally updated the local Crew plugin caches. Test processes and credential fixtures were removed; unrelated sessions and Keychain items were preserved.

## Follow-up: stale root Codex notifications — 2026-10-01

Crew **0.11.1** corrects a missed root-advisor case. The 0.11.0 root-only queue exemption
was insufficient: a root can consume mail while still working, and a subsequent batch queues
another future user turn. The earlier pointers remain in Codex independently of the inbox cursor.
The reported session's actual transcript contained 13 Crew pointer messages; its inbox cursor
had reached the end. The last mail arrived at 16:55 UTC, while pointers replayed around 17:23–17:25 UTC.
No analytics files, session history or mailbox contents were modified during diagnosis.

Automatic `codex queue` calls are now removed for all mail and keepalives. Foreground `crew wait`
returns mail within the advisor's current turn. Its Stop hook hands over unread batches before
the turn finishes. Advisor/team instructions require inbox reads at handoffs and foreground
waiting while required child work remains. Herdr prompts and retained headless resumes still
use their existing transports; hook command strings were preserved.

This is not a new steering transport. The installed CLI exposes queue without a steering or
cancellation option. The desktop owns a stdio app server; its default CLI proxy socket was absent.
The documented [turn/steer API](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
requires the owning server and matching active turn ID. A separate app server would not steer
that desktop conversation. An ended desktop root therefore has no automatic Crew wake; its
advisor must keep the turn alive while required children are working. Existing pointers already
submitted to Codex are outside Crew's inbox lifecycle.

Verification:

- The batch-consumption regression fails against the previous `src/mail.ts` with an unexpected
  `codex-queue` delivery, and passes against the correction. The probe used an isolated copy.
- Repeated root Stop-hook delivery and consumption, concurrent CLI sends, armed foreground
  wait, missing Codex executable and cold-transcript keepalive checks pass without queue writes.
- Full suite: 128 tests, 127 passed, zero failed, one sandbox skip (`ps` unavailable).
  The skipped process-ancestry test passed separately outside the sandbox.
- Typecheck and diff whitespace checks passed.
- Installer completed; Claude Code and Codex 0.11.1 caches both contain the corrected guide.

Local logs: [before-fix regression](/tmp/crew-root-wake-before.log),
[full suite](/tmp/crew-root-wake-tests.log), [focused regressions](/tmp/crew-root-wake-focused.log),
[process ancestry](/tmp/crew-root-wake-ancestry.log), [installation](/tmp/crew-root-wake-install.log).

## Follow-up: exposed owning server and direct root mail — 2026-10-01

Crew **0.12.0** adds an opt-in Codex root transport. The desktop was relaunched with an explicit
local Unix endpoint and its existing Code Mode/app-tools/code-review launch options. This exact
root was verified loaded with `canAcceptDirectInput=true`; an automatic restart continuation was
accepted through `turn/start`. The earlier daemon-shortcut restart had fallen back to stdio and
sent no continuation. The unused diagnostic daemon was stopped after confirming its recorded PID
and zero loaded threads. The desktop's owning control server remains running.

`crew connect` discovers an explicit listener in its own Codex process ancestry, or accepts
`--socket`/`CREW_CODEX_SOCKET`, verifies ownership and records the recipient endpoint. Registration
wins over an older parent endpoint. Automatic delivery preserves the inbox, checks it again under
the consumption mutex, then uses `turn/steer` with the current active turn ID or `turn/start` for an
idle loaded root. Unsupported/unloaded roots retain inbox/wait/hooks. It never calls `thread/resume`,
changes the root's model/permissions, or reinstates `codex queue`.

The wake attempt is persisted before RPC. Accepted or ambiguous attempts cover an unread batch
without expiring into replay; protocol rejections permit a later delivery to retry, with no immediate
retry or steer-to-start downgrade. Ownership/RPC calls and lock waits are bounded. Native Node
WebSocket framing is carried over a short-lived, one-use nonce-protected loopback-to-Unix bridge;
there is no new runtime dependency or permanent TCP listener. Hook command strings are unchanged.

Validation: **140 tests passed, zero failures/skips**, `npm run typecheck` and `git diff --check` passed.
The installer updated Claude/Codex caches to 0.12.0. New isolated regressions cover active/idle
selection, consume-before-send, simultaneous senders, expected-turn rejection, lost acknowledgements,
timeouts, waiter precedence, pagination, root ownership, connection registration and endpoint migration.

Live evidence uses the real desktop root and Claude Code run `b-y01njd80a`, session
`4848ddd1-4bba-4804-9c2f-e91dfbf583a7`:

```text
Claude -> active Codex: STEER-LIVE-CLAUDE-INITIATED-20261001
Codex -> Claude: STEER-LIVE-CODEX-REPLY-20261001
Claude -> Codex: STEER-LIVE-CLAUDE-CONFIRMED-20261001
Claude result: DONE: CLAUDE-INITIATED-ROUNDTRIP

Codex -> same Claude session, Amendment 1: STEER-LIVE-CODEX-INITIATED-20261001
Claude -> Codex: STEER-LIVE-CLAUDE-REPLY-20261001
Claude result: DONE: CODEX-INITIATED-ROUNDTRIP
```

Actual inbox consumption and result artifacts corroborate both initiating directions. The root's
accepted wake receipt uses `turn/steer` and the same active turn ID as the restart continuation,
`01a0f8f6-75e2-7552-a40f-3bffbb946e6d`. A separate idle protocol test root
`01a0f903-2ffb-7490-95ef-7c51d8066abc` received Crew's `codex-start`, consumed its temporary inbox
(cursor advanced to 164), and wrote `IDLE-INBOX-CONSUMED-20261001`. The first ephemeral idle probe
accepted `codex-start` but its history-read method was unsupported; it is not claimed as consumption
proof. Both ephemeral probes are unloaded. The Claude probe is stopped; predecessor results remain.

Local evidence: [/tmp/crew-steering-evidence](/tmp/crew-steering-evidence),
[final tests](/tmp/crew-steering-tests-final.log), [typecheck](/tmp/crew-steering-typecheck-final.log),
[installation](/tmp/crew-steering-install.log). The desktop switch is internal to the installed build;
future ordinary launches may return to stdio. Use the local launcher after quitting the desktop,
then `crew connect` in new root advisors. Details: [Codex steering setup](docs/codex-steering.md).

## 0.12.1 — managed daemon discovery and checkpoint permissions, 2026-10-02

The interrupted CoS session showed two independent setup failures: `crew connect` did not
recognize a managed `--listen unix://` endpoint, and checkpoint initialization attempted to
create `~/.advisor/.../locks/checkpoint` outside its writable roots. The checkpoint already
existed after its approved retry; no Crew child runs had been launched for that session.

Crew now discovers managed defaults under `CODEX_HOME`, including when process visibility is
restricted, while still requiring the exact loaded root and direct-input capability. Unix
endpoint symlinks are resolved before the socket path-length limit applies. Connection failures
retain their OS code, syscall and endpoint; a sandboxed live call reports `EPERM (connect)`.
The outside-sandbox approved call verifies ownership successfully. Directory write permission
alone does not permit Unix socket IPC; advisor and worker guidance now distinguishes the two.

The installer grants shared Crew/checkpoint state to Codex and Claude roots; child launches
include advisor checkpoints (or `ADVISOR_STATE_DIR`) along with Crew state and the git directory.
The isolated installer regression checks multiline writable roots, preservation of unrelated
settings and approval/sandbox choices, and idempotence. Full validation: **142 tests passed,
zero failures/skips**, typecheck passed; the final installer-only delta also passed its focused
regression and typecheck. Earlier live Claude↔Codex roundtrip evidence above remains historical
0.12.0 evidence; this patch's new live proof is connection/ownership, not another agent exchange.

Live ownership was verified for this desktop root on `~/.crew/desktop-control.sock` and the
interrupted CoS root `01a0fc42-89ed-7c73-a026-34f53c9081b7` on the managed default socket. Its
registration is recorded; no turn was started, steered or resumed for that workstream.
Claude/Codex plugin caches are installed at 0.12.1. Existing chats can retain old permission
snapshots and must refresh their permission selection or launch a new session.

Separately, at the user's explicit request, local global defaults were changed to Codex
`approval_policy="never"`/`sandbox_mode="danger-full-access"` and Claude
`permissions.defaultMode="bypassPermissions"`/`sandbox.enabled=false`. The user's local Crew
Claude `auto` override was removed so launches inherit that choice. A fresh temporary Codex
server confirmed the effective defaults via `config/read` without starting threads. Backups
are under `~/.crew/backups/2026-10-02T11-48-13-global-permissions`. These are personal settings,
not defaults shipped by Crew, and the installer preserves them.
