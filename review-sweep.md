# Crew lifecycle review and implementation — 2026-09-30

Implementation: **Crew 0.11.0**, installed in the local Claude Code and Codex plugin caches. Default launches remain fresh runs. Retained headless sessions now have an optional, serialized resume path. The original review's retained-worker, liveness, settlement-delivery and team-guidance findings are resolved.

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
