import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as AcpClient from "../../packages/effect-acp/src/client.ts";
import * as Schema from "effect/Schema";
import { ServerSettings } from "../../packages/contracts/src/settings.ts";
import { AcpRegistrySettings } from "../../packages/provider-acp-registry/src/settings.ts";
import { providerSettings, repository } from "./setup.mjs";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeAcpSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

it.layer(NodeServices.layer)("CrewCode ACP integration", (it) => {
  it.effect("negotiates with T3, receives activity and results, and amends follow-ups", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-t3-test-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const crewBin = NodePath.join(home, "crew");
      yield* Effect.promise(() =>
        NodeFSP.copyFile(NodePath.join(repository, "scripts/crewcode/fixtures/crew.mjs"), crewBin),
      );
      yield* Effect.promise(() => NodeFSP.chmod(crewBin, 0o700));
      const settings = providerSettings({ home, crewBin });
      const decoded = decodeSettings(settings);
      NodeAssert.equal(decoded.defaultModelSelection.instanceId, "crew");
      NodeAssert.equal(decodeAcpSettings(decoded.providerInstances.crew.config).source, "local");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [NodePath.join(repository, "scripts/crewcode/acp.mjs")],
          {
            cwd: repository,
            env: {
              ...process.env,
              CREWCODE_HOME: home,
              CREW_HOME: NodePath.join(home, "crew-state"),
              CREWCODE_CREW_BIN: crewBin,
            },
          },
        ),
      );
      yield* Effect.gen(function* () {
        const client = yield* AcpClient.AcpClient;
        const updates = [];
        yield* client.handleSessionUpdate((update) =>
          Effect.sync(() => {
            updates.push(update);
          }),
        );
        const initialized = yield* client.agent.initialize({
          protocolVersion: 2,
          clientInfo: { name: "crewcode-test", version: "1" },
        });
        NodeAssert.equal(initialized.protocolVersion, 1);
        NodeAssert.equal(initialized.agentInfo.name, "crewcode");
        const session = yield* client.agent.createSession({ cwd: home, mcpServers: [] });
        const result = yield* client.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "First request" }],
        });
        NodeAssert.equal(result.stopReason, "end_turn");
        const followup = yield* client.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Second request" }],
        });
        NodeAssert.equal(followup.stopReason, "end_turn");
        NodeAssert.ok(updates.some((event) => event.update.sessionUpdate === "tool_call"));
        const messages = updates.filter(
          (event) => event.update.sessionUpdate === "agent_message_chunk",
        );
        NodeAssert.equal(messages.length, 2);
        NodeAssert.match(messages[1].update.content.text, /Second request/);
      }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
    }),
  );
});
