# CrewCode

CrewCode brings your Crew into T3 Code's web workspace. Each conversation starts a Crew advisor, and your Crew configuration chooses its model and workers. Follow-ups, worker activity, results, and cancellation pass through the local ACP bridge.

This directory permanently stores the integration in the Crew repository. The setup script fetches a pinned public T3 Code commit, applies the small UI/package patch, and copies the bridge source into a separate app checkout. It verifies the complete Git tree against the tested CrewCode source before creating a local commit. No cloud session or separate fork is needed to run it.

## Run on your laptop

Use macOS, Linux, or Windows with WSL2. Install Git, **Node 24.13.1 or newer in the 24.x line**, and **pnpm 11.10.0**. Install Crew using the [main setup instructions](../../README.md#quickstart), including host hooks and their trust prompts, and sign in to the Claude/Codex CLIs your roster uses. Crew's default advisor uses Claude; configure Crew if you only use Codex.

From a checkout of this Crew branch:

```sh
node integrations/crewcode/setup.mjs
cd .crewcode-app
pnpm install --frozen-lockfile
pnpm crewcode
```

The setup step needs GitHub access; dependency installation needs package registry access. The generated app uses `bin/crew` from this Crew checkout automatically. Normal Crew routing, roster, configuration, and host sign-ins apply. The setup script does not install host hooks or launch agents.

Open the **complete pairing URL** printed by the dev runner, add a project, and select **Crew · automatic routing**. Stop the app with Ctrl-C. After restarting your laptop, start it again with:

```sh
cd /path/to/crew/.crewcode-app
pnpm crewcode
```

Your app state stays in `.crewcode-app/.crewcode`; Crew retains its normal state in `~/.crew` or your configured `CREW_HOME`. Keep those directories for local conversation history. GitHub stores source, not your local conversations or credentials.

Setup refuses to overwrite an existing destination. If dependency installation fails, rerun `pnpm install --frozen-lockfile` in the prepared app; do not rerun setup. A failed source fetch or verification may leave a partial directory: inspect it before removing it, or pass a new destination with `node integrations/crewcode/setup.mjs /path/to/new-directory`. If you move either checkout, update the provider paths in Settings or configure a new profile.

## Review and verify

- `files/scripts/crewcode/` contains the bridge, setup/launch code, and focused tests as normal source files.
- `upstream.patch` contains the changes to existing T3 Code files; `upstream.json` pins the upstream commit and resulting source tree.
- [The user guide](files/docs/user/crewcode.md) explains configuration, troubleshooting, and current limitations.
- T3 Code remains MIT licensed; its notice is preserved in [T3-LICENSE](T3-LICENSE) and in the generated checkout.

From the prepared app:

```sh
pnpm crewcode:test
pnpm exec vp test run scripts/crewcode/t3-protocol.test.mjs apps/web/src/branding.test.ts
```

Crew's CI also runs the dependency-free bridge tests directly from this directory with `node --test integrations/crewcode/files/scripts/crewcode/acp.node-test.mjs`.

The focused tests cover lifecycle/cancellation, settings, branding, and T3's real ACP client against a fixture Crew executable. A live advisor run additionally needs working host authentication and model endpoint access.

This is the initial source-run web integration. It shows worker status and final results; token streaming, native child-agent cards, T3 approval dialogs, T3-injected MCP/scheduling tools, and packaged desktop/mobile releases are not implemented. Model-generated titles and commit messages need a separate text-generation provider.
