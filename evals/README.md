# Crew behavior evals

`npm test` proves runtime and scorer regressions with stubbed hosts. `npm run eval`
checks synthetic positive, counterexample, missing-evidence and unbacked-evidence
observations. Neither command proves a model follows Crew responsibilities.

```sh
npm test
npm run typecheck
npm run eval -- --out /tmp/crew-eval-reports
npm run eval -- --list
```

Fixture reports say `surface: fixtures`, `mode: fixtures`, `proof: scorer-fixtures-only`, `model: null`,
and `launchCount: 0`. Fixture PASS means the scorers accepted examples and rejected
counterexamples, not that CoS/advisor behavior happened. The assertions deliberately
have evidence locators and do not consume a model's declared PASS.

## Real provider workflows (explicit opt-in)

Use Node >=24, Git, and an installed Codex CLI with `exec --json`, `exec resume`,
workspace-write, local hooks and `--dangerously-bypass-hook-trust` support. The latter
trusts only this checkout's vetted hooks in an isolated home; this runner uses
workspace-write with approval policy `never`, not an approval/sandbox bypass. If the
host cannot run with those controls, that is a setup blocker, not behavior proof.
Workspace-write explicitly enables network access so nested Codex children can reach
the configured provider from the root's tool sandbox; read/write boundaries still apply.
The CoS case also requires the integrated `assign`/immutable-submission/`accept`
runtime (`src/assignment.ts`). No project or global packages are installed by evals.

Supply a regular Codex auth JSON file explicitly. The runner does not discover login
files, symlink host state, inherit provider keys, or copy personal configuration.
Use a path to an existing login file you authorize copying for this run; never put
credentials themselves in arguments. The copy is mode0600 in temporary CODEX_HOME.

```sh
npm run eval:live -- \
  --surface cli \
  --case cos-integration-reuse \
  --model gpt-6.1-sol \
  --codex-auth-file /absolute/path/to/authorized/auth.json \
  --timeout 900 \
  --out /absolute/path/to/eval-evidence

npm run eval:live -- \
  --surface cli \
  --case advisor-tiny-repair \
  --model gpt-6.1-sol \
  --codex-auth-file /absolute/path/to/authorized/auth.json \
  --timeout 300 \
  --out /absolute/path/to/eval-evidence
```

The model is explicit; no root model/global settings change. The same model is the
isolated roster's default for all roles. `--codex-bin /absolute/path/to/codex` supports
a nonstandard CLI install. Live root/provider calls are foreground subprocesses;
Crew launches retained children normally, with their recorded PIDs and transcripts.
A CoS run costs one root plus useful advisors and a retained-session follow-up; its
launch count records actual Crew members, not a fixed staffing limit.

The CoS root reads the current checkout's CoS and handoff skills, receives two
independent shop outcomes and their acceptance interfaces, and chooses decomposition,
missions and implementation. It must integrate useful stock/sales artifacts, accept
exact immutable submissions, reuse the stock owner for another outcome and preserve
the prior result. The prompt supplies no spawn recipe, worker sequence or JSON plan
schema. The tiny advisor case asks for a real one-file repair and execution of an
immutable verifier; delegation is a model decision and unnecessary launches fail.

Each run receives a temporary synthetic Git repo and isolated HOME, CODEX_HOME,
CLAUDE_CONFIG_DIR, XDG homes, CREW_HOME/CONFIG/ROSTER and ADVISOR_STATE_DIR. Session,
Herdr, socket and credential environment markers are discarded. PATH targets the
checkout CLI through a receipt recorder; unused Herdr/Claude/OpenCode/router tools
fail closed. `CREW_NO_DELEGATE=1` prevents plugin-cache delegation. Root `crew connect`
is pinned to a nonexistent sandbox socket; no personal app server is attached.

On normal return, failure, timeout, SIGINT or SIGTERM, only recorded owned process
groups/watchers are stopped and the temporary home/auth copy is removed. SIGKILL or
power loss cannot run cleanup; remove the reported OS temp `crew-live-eval-*` sandbox
if a run is forcibly killed. Sanitized report/evidence directories remain under
`--out`, with mode0600 files. Raw host homes/session stores and auth files are never
copied into evidence. Known auth values plus common token formats/credential fields
are scrubbed before persistence. Keep evidence access restricted.

Exit codes: **0** evaluated case passed, **1** behavior/timeout/execution failed,
**2** missing auth/runtime/CLI or unavailable login blocked. Missing auth never
passes. Setup failures remain distinct from behavioral failures. Adapter unit tests
use synthetic auth and fake hosts only; they prove adapter capture/timeout/cleanup,
not a provider's model behavior.

## Catalog and proof boundaries

| Case | Live coverage | Assertions |
| --- | --- | --- |
| `cos-integration-reuse` | Real Codex tools | Independent retained owners, distinct correct artifacts, integrated data, exact accepted refs/hash/revision/parent, same retained session reused, preserved pre-assign snapshot, accounted descendants |
| `advisor-tiny-repair` | Real Codex tools | Correct direct artifact, bounded file inventory, immutable verifier actually executed, no unnecessary Crew launch |
| `handoff-levels` | Fixture/policy probe | Advisor decision rights, worker boundary, no mission recipe |
| `checker-repair` | Fixture/policy probe | As-found versus repaired verdict, bounded repair, changed delta verification |
| `compaction-recovery` | Fixture/policy probe | Current contract and ownership recovery, next-action resumption |
| `precise-acceptance` | Fixture/policy probe | Stale refusal, exact current acceptance, prior snapshot preservation |

A live report contains the selected case's assertions and marks all other cases
`not-executed`; it does not promote fixture checks to model PASS. The CoS live case
covers successful precise acceptance/reuse, while actual stale-ref rejection and
compaction belong to runtime regression tests until corresponding provider probes
exist. Decision latitude and mission quality still need a human review of captured
packets/tool traces: counts and artifacts alone cannot assess all semantic policy.

Reports save mode, model, case, assertion status/evidence paths, duration, launch
count and limitations. `contracts.json` records the checkout revision and hashes of the actual skills/hooks;
`capture.json` holds runtime records and real command receipts;
`root.jsonl`, child `exec.jsonl`, packets/results, immutable submissions and workspace
artifacts are independently inspectable. Scoring uses actual completed command events,
content and hashes, not source-prose matching or the model's reported success. CLI
receipts capture immutable bytes before `assign`, so a rewritten old result cannot
pass preservation merely by claiming it did.
The tiny case also requires a successful recorded `node verify.mjs` invocation in
the workspace, with immutable verifier/instructions and delivered greeting bytes
matching before and after that process. Echoed or skipped command text cannot pass.
The CoS case binds each domain artifact to a successful owner turn's before/after
snapshot, including the initial stock artifact before reuse. Passive advisors plus
root-created files do not satisfy that evidence. These are turn-window snapshots,
not filesystem write attribution; review overlapping tool traces and owner checks
when assessing verification quality.

The recorder is an evaluation aid, not a security boundary against a malicious model.
No browser journeys are exercised by the CLI surface. Root integration should run
repo checks and these opt-in provider probes on the integrated revision. Keep the saved
contract/revision provenance alongside evidence when evaluating a release; this child implementation
alone does not claim that a live model passed.

## Console API surface

The same explicit live opt-in can run the actual Crew HTTP console with an owned
Codex stdio app-server in isolated homes. This adapter currently covers only
`advisor-tiny-repair`; its default case is that repair. CLI defaults and coverage
remain unchanged.

Console setup uses Codex 0.160.1's `hooks/list` and `config/batchWrite` protocol,
without an app-server hook-trust bypass flag. A separate owned stdio setup server
initializes without starting a thread or model turn. Every listed hook must match
this checkout's vetted `codex/hooks.json` bytes and exact source path, event,
command, matcher, timeout and async fields. Only those keys/current hashes are
written under `hooks.state` in the isolated `CODEX_HOME/config.toml`; a second list
must show every same hook enabled/trusted. Missing, foreign, changed or disabled
hooks block setup. No global configuration or product adapter trust is changed.

`setupIsolatedHookTrust` from `evals/hook-trust.ts` is reusable by an owned private
harness. Pass `{base, workspace, env, codexBin, vettedHooksFile, signal?}` with a
fully isolated environment, canonical `base/home` and `base/codex` directories,
a canonical workspace below `base`, and this imported checkout's explicit
`codex/hooks.json` path as `vettedHooksFile`. The copied file must be a regular
byte-exact copy. The helper closes its setup server before returning reviewed
before/after metadata; the console runner retains it as `hooks-trust.json`.
Fake RPC regression tests establish these validation and cleanup mechanics;
root-owned live calls establish installed-provider behavior.
Setup has its own bounded 10-second budget. The requested behavioral `--timeout`
starts after the managed provider acknowledges the initial human input, so hook
setup/cold startup cannot consume the model workflow's budget. Reports retain
total elapsed duration. Setup errors before a managed launch block; failures
after a managed launch fail. Both paths remove copied credentials and owned hosts.

```sh
npm run eval:live -- \
  --surface console-api \
  --case advisor-tiny-repair \
  --model gpt-6.1-sol \
  --codex-auth-file /absolute/path/to/authorized/auth.json \
  --timeout 300 \
  --out /absolute/path/to/eval-evidence
```

The runner starts `crew console --port 0`, reads the bootstrap capability, and
sends same-origin mutations through HTTP. It replays the launch and second-input
request IDs, captures two separate SSE connections, and checks preserved event IDs,
ordering and bytes. Independently recorded provider stdin requests must show one
thread start and exactly two input starts with their actual request IDs and text;
deduplicated UI history cannot hide duplicate provider work. The second human input contains a new random nonce generated
only after the first turn finishes; a separately inspected `followup.json` must
contain it and the repaired greeting. Echoing a nonce in assistant prose cannot pass.

Private snapshots of the runner's own `CREW_HOME/console/sessions/<id>` bind the
managed root, actual provider thread and delivered command states. A recorded shell
`node verify.mjs` invocation must have the actual `CODEX_THREAD_ID`, successful exit
and exact immutable verifier/instruction/greeting bytes before and after execution.
Normalized native console tool events are scored directly; the adapter never
fabricates exec `item.completed` events. Default `npm run eval` also checks synthetic
console captures for wrong identity, receipt without delivery, duplicate work,
missing/echoed verifier, incorrect bytes, stale history and stale/wrong nonce artifacts.

Console reports identify `surface: console-api` and retain HTTP receipts, SSE
updates, public conversation details, private identity/command snapshots, real
subprocess receipts and source/contract/scorer hashes in `contracts.json`. Hashes
cover actual working-tree bytes, including dirty sources. Saved files are sanitized
and mode0600; the bootstrap token and copied auth/home never enter retained evidence.
The only extra recorder allowance is an isolated owned `app-server --listen stdio://`
with the eval's exact homes and workspace. CLI recorder daemon restrictions stay in
place. Cleanup explicitly closes the managed session through HTTP, then stops only
verified owned process groups and removes the private sandbox on errors, timeouts
and signals as well as success.

This is **console API proof**, with credential-free fake-provider integration tests
establishing adapter mechanics. It does not prove browser interaction, Claude
behavior, CoS console delegation, or another catalog case. Real provider and browser
verification must run on the integrated revision; fake-provider tests cannot stand
in for those checks.
