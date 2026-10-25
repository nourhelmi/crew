# CrewCode

CrewCode brings your Crew into T3 Code's workspace. Every conversation starts a Crew advisor; your Crew roster and router choose its model and the workers it delegates to. Follow-ups amend the same advisor's assignment when its native session can be resumed. Worker activity appears in the conversation, followed by the advisor's result.

## Start locally

Install Node 24.13.1 or later in the 24.x line and pnpm 11. Install [Crew](https://github.com/nourhelmi/crew) using its setup instructions, including the hooks for your host CLIs, and sign in to the agents your roster uses. `crew roster` shows your configuration. Crew's default advisor uses Claude; configure Crew's advisor default or roster if you only use Codex.

From this checkout:

```bash
pnpm install --frozen-lockfile
pnpm crewcode --crew /absolute/path/to/crew/bin/crew
```

If `crew` is already on PATH, `pnpm crewcode` is sufficient. Open the web address printed by the dev runner. Add a project and start a conversation with **Crew · automatic routing** selected.

CrewCode creates `.crewcode/userdata/settings.json` and selects Crew. Codex and Claude's direct providers start disabled in this new profile; Crew still uses those CLIs through its own routing. Your existing T3 profile is separate. Repeating setup preserves your settings. If you move the checkout or Crew executable, update the Crew provider in **Settings → Providers**, or choose a new profile with `--home /absolute/path`.

For an existing T3 installation, add **Settings → Providers → Add provider → Local ACP command**. Set the executable to your Node 24 binary and its single argument to the absolute path of `scripts/crewcode/acp.mjs` in this checkout. Set `CREWCODE_CREW_BIN` in the provider's environment if Crew is not on PATH. Select the `crew-auto` model.

## Your Crew settings

CrewCode preserves `CREW_HOME`, `CREW_CONFIG`, `CREW_ROSTER`, and `CREW_ROUTER`. Your normal Crew routing, capacity limits, skills, and host sign-ins remain in charge. Configure those in Crew rather than selecting individual models in CrewCode.

The conversation's stop action cancels its advisor and descendants. A subsequent prompt starts a replacement advisor with recent conversation context. Normal follow-ups use the kept advisor. If native resume information is unavailable, CrewCode uses a replacement with recent context instead. Disconnecting the bridge stops its owned runs; reopening a conversation restores its saved messages.

## Current scope

- Text prompts and embedded text context are supported. Images and audio are rejected explicitly.
- Worker status and final results are shown. Token streaming and native child-agent cards are not implemented.
- Host CLIs enforce their own sandbox and approvals. CrewCode does not translate T3's permission picker into host permissions or display host approval dialogs. Complete approval or sign-in steps in the native CLI; cancel from CrewCode if a headless run cannot proceed.
- MCP servers configured in the native hosts are available to Crew. T3-injected MCP servers and T3 scheduling tools are not forwarded by this bridge.
- Model-generated thread titles, commit messages, and similar app actions need a separate text-generation provider. They do not run through the Crew bridge.
- The source-run web app is supported here. Desktop packaging, release signing, mobile branding, and hosted deployment are not part of this initial integration.

T3's conversation persistence and checkpoint machinery remain in place; Crew owns agent execution and delegation. This keeps existing project, diff, terminal, and file-restore behavior available.

## Troubleshooting

Run `crew ls --all` and `crew read <run-id>` to inspect a stalled host. Network access and authentication must work for each CLI selected by your Crew roster. The bridge reports launch failures and stalled runs instead of reporting success.

Sessions live under `CREWCODE_HOME/sessions`, or `~/.crewcode/sessions` when the bridge is added manually without that variable. Only one bridge can load a session at a time. After a hard process crash, stop any remaining workers and verify no bridge owns the session before removing its `.json.lock` file. Do not remove a lock belonging to a live bridge.

## Contributor checks

```bash
pnpm crewcode:test
pnpm exec vp test run scripts/crewcode/t3-protocol.test.mjs apps/web/src/branding.test.ts
```

The protocol integration test uses T3's actual ACP client and a fixture Crew executable in a temporary directory. It verifies the protocol and CLI boundary without model calls. A live model run additionally requires authenticated CLIs and permitted model endpoints.
