# Codex root steering

Crew can use a Codex root's owning app-server Unix socket. This is opt-in; no remote-control
service, credentials, global Codex settings, or persistent TCP listener is needed.

## CLI

Start a server with a private absolute socket path, then attach the client to that same server:

```sh
codex app-server --listen unix:///absolute/private/path/server.sock
codex --remote unix:///absolute/private/path/server.sock
```

Inside the root, run `crew connect`. It can discover an explicit Unix listener in its own Codex
process ancestry. If process visibility is restricted, pass the endpoint:

```sh
crew connect --socket /absolute/private/path/server.sock
```

The connection is recorded in that root's Crew mailbox and inherited by newly spawned children's
parent addresses. Existing children and raw root-mailbox sends also resolve this registration;
a new explicit registration takes precedence over a stale parent endpoint.
If the root's tool environment carries `CREW_CODEX_SOCKET`, `crew connect` can omit `--socket`.
A local `CODEX_APP_SERVER_WS_URL=ws+unix://localhost/absolute/path/server.sock:/rpc` is also understood.
A remote WebSocket URL is not used for automatic mail.

The protocol is documented in [OpenAI's app-server reference](https://learn.chatgpt.com/docs/app-server).
Its transports and experimental fields can change; unsupported responses leave mail in the inbox.

## Desktop configuration verified on 2026-10-01

The installed desktop (bundled Codex 0.159.2) accepts `CODEX_APP_SERVER_WS_URL` at application launch.
This is an internal installed-build switch, not a public stable desktop setting. The tested local
endpoint is `ws+unix://localhost/Users/nour/.crew/desktop-control.sock:/rpc`.

A dedicated server uses the desktop's existing `features.code_mode_host=true`, app-tools MCP and
code-review MCP launch options. The initial `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` attempt fell back
to stdio because the desktop supplies additional plugin options. The explicit endpoint succeeded.
No application bundle patches, auth changes, global configuration writes, or cloud Remote Control
were needed. The server's socket is private; Crew's temporary loopback bridge accepts one connection
with a random nonce, rejects browser Origin headers, and closes after the RPC session.

The local launcher is `~/.crew/open-desktop-with-daemon.sh`; run it after quitting the desktop.
It refuses to interrupt a running desktop, starts/reuses only its recorded control server, and
opens the application with the explicit endpoint. The companion start script, PID file and log live
in `~/.crew`. Ordinary launches that do not supply this endpoint may use private stdio again.

Verify `thread/loaded/list` includes the intended root and `thread/read` reports
`canAcceptDirectInput=true`. A successful handshake or persisted thread file is insufficient.
`crew connect` performs this ownership check. It never calls `thread/resume`.

## Delivery behavior

- Mail is durable before any push. Foreground waits take precedence.
- Active roots use `turn/steer` with the authoritative current turn ID. A mismatch is not retried
  as a new turn. Idle loaded roots use immediate `turn/start`, preserving thread settings.
- The inbox is checked again under its consumption mutex after ownership RPCs. A batch consumed
  before sending gets no pointer. Only advice pointers are pushed; packet amendments carry scope.
- Accepted and ambiguous attempts cover their unread batch without a timer. A transport timeout
  may have been accepted, so it cannot be automatically retried. Read the inbox to resolve it.
- A definitive protocol rejection leaves mail unread and allows a later delivery to try again.
  Unloaded roots, unavailable endpoints and unsupported protocol fields use inbox/wait/hooks.
- No root is loaded, resumed, cloned, or interrupted for delivery. No `codex queue` fallback exists.
