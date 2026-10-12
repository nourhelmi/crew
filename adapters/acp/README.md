# Optional ACP facade

Run `crew acp` as an ACP stdio agent. The adapter is loaded only for that command,
uses Node's built-ins, and delegates native Codex/Claude ownership to Crew's
console controller. No application IDs, application credentials, or application
configuration belong in Crew.

## Supported wire contract

The connection negotiates ACP **v1**, including when a client proposes a newer
version. Clients that cannot fall back to v1 must refuse the connection.

- `initialize`, `session/new`, `session/load`, `session/list`, `session/prompt`,
  `session/cancel`, `session/set_mode`, `session/set_model`, and
  `session/set_config_option`.
- Text and resource-link prompt blocks. Images, audio and embedded resources are
  rejected before a native send. Native tool output is text, not a reconstructed
  file diff or client terminal.
- Stdio and HTTP MCP configuration travels through private native protocol setup.
  SSE is unsupported. Changed MCP configuration on load first suspends the owned
  tree, then refreshes its private configuration without changing native IDs.
- Models are enabled, available Codex/Claude roster entries, identified as
  `host/model`. The `default` model alias resolves to the session's selected
  roster model. There is no fabricated `crew-auto` model.
- Advisor/CoS, lead model and effort can change in the same session. An active
  root finishes its current turn before a queued selection applies; approvals
  and cancellation remain available meanwhile. Only the root pipe reconnects,
  retaining its exact native identity, conversation, checkpoint and workers.
  Both Advisor → CoS and CoS → Advisor update the existing checkpoint mode.
  After launch, available lead models belong to that session's native provider;
  switching between Codex and Claude requires a new session. Native permission
  policy is also fixed after launch. Initial native launch still waits for the
  first prompt, and selecting the current value is harmless.
- The prompt stays open until the root and managed descendants are quiescent.
  Running, starting, or approval-waiting workers keep it open. Cancel interrupts
  the root and reachable managed workers, including idle workers with possible
  unread mail, preserving native identities.

Human messages go to the root advisor or CoS only. There is no worker messaging,
worker amendment endpoint, external child-control endpoint, or separate child
chat transport in this adapter. The native Crew workflow owns delegation.

## Worker visibility

All text/tool updates use the **root ACP session ID**, so a generic client can
render worker output in the parent conversation. Worker lifecycle tool IDs are
`crew-worker:<runId>`. Worker event IDs are `<runId>:<eventId>`.

Optional `update._meta.crew` (and permission `toolCall._meta.crew`) metadata is:

```json
{
  "version": 1,
  "runId": "builder-example",
  "parentRunId": "advisor-example",
  "childSessionId": "acpc-opaque-stable-id",
  "role": "builder",
  "title": "Implement bounded task",
  "task": "Implement bounded task",
  "model": "codex/model-from-roster",
  "effort": "low",
  "state": "running",
  "nativeState": "waiting",
  "managed": true
}
```

`parentRunId` and `assignmentState` are optional. `childSessionId` is a stable
presentation identifier, **not** a session accepting prompts. These fields do
not grant ownership or authorize commands. A client may optionally map them into
read-only child views; ACP does not standardize that UI.

## Exact approvals and questions

`session/request_permission` binds each response to its original native pending
request and owning root/worker. Only an offered option can be selected; stale
replies never authorize later turns. Cancelled responses interrupt associated
work. Ordinary chat and Crew mail never satisfy permissions.

Questions use `elicitation/create` only with explicitly negotiated
`clientCapabilities.elicitation.form`. Otherwise a client may advertise
`clientCapabilities._meta.crew.questions: true` for `_crew/request_question`:

```json
{
  "sessionId": "acp-root-id",
  "request": {
    "id": "opaque-native-question-id",
    "kind": "question",
    "title": "Choose an approach",
    "questions": [{ "id": "strategy", "question": "Which approach?" }]
  },
  "_meta": { "crew": { "version": 1 } }
}
```

Respond with `{ "answers": { "strategy": "answer" } }` or
`{ "cancelled": true }`. Without either negotiated question transport, the
question remains pending and the root receives an explicit unsupported-client
notice; the adapter never guesses an answer.

## Persistence and limits

Adapter sessions, transcript updates and exclusive connection claims are private
files under `$CREW_HOME/adapters/acp`. Native credentials/process handles stay in
the console controller. Session setup can contain private MCP credentials and is
never echoed in public updates. Transcript replay consolidates full native event
upserts and resumes their recorded feed cursors. A journal gap is reported,
never silently presented as complete history.

Disconnect suspends only the connection's owned roots and descendants and keeps
exact native identities available for later load/prompt. Deliberately closed
Crew sessions cannot be revived. Failed cleanup retains its ownership claim;
it is not reported as successful termination. Abrupt process death is recovered
through the controller's recorded ownership checks, not prompt replay.

The facade is not a claim of identical UI support across ACP clients. Protocol
checks use a fake native controller; native provider authentication and desktop
rendering require separate integration evidence.
