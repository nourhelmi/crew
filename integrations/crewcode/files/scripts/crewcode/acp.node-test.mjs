import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";
import { CrewAcpAgent, serve } from "./acp.mjs";
import { CrewClient, crewEnvironment, resultHash } from "./crew-client.mjs";
import { setup } from "./setup.mjs";

async function fixture(t, behavior = {}) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-test-"));
  const clients = new Map();
  const updates = [];
  let spawned;
  const launched = new Promise((resolve) => {
    spawned = resolve;
  });
  const agent = new CrewAcpAgent({
    home,
    pollMs: 1,
    timeoutMs: 1000,
    notify: (event) => updates.push(event),
    client(id) {
      if (!clients.has(id)) {
        const client = new CrewClient(id, { env: { CREW_HOME: home } });
        Object.assign(client, {
          entries: [],
          output: "",
          spawnCount: 0,
          amendCount: 0,
          async runs() {
            return structuredClone(this.entries);
          },
          async result() {
            return this.output;
          },
          async spawn(cwd, packet) {
            this.spawnCount++;
            if (behavior.beforeSpawn) await behavior.beforeSpawn();
            const run = {
              id: `a-${this.spawnCount}`,
              name: "advisor",
              role: "advisor",
              route: { model: "test-model" },
              cwd,
              state: "running",
              sessionId: "native-session",
              parent: { mailbox: this.env.CREW_MAILBOX },
            };
            this.entries.push(run);
            if (!behavior.hold) this.settle(packet);
            spawned();
            return structuredClone(run);
          },
          settle(packet) {
            this.output = `# Status\nDONE\n# Evidence\n${packet.match(/CrewCode turn ID: (.*)\./)?.[1] || "result"}`;
            this.entries.at(-1).settled = { hash: resultHash(this.output), status: "DONE" };
          },
          async amend(id, packet) {
            this.amendCount++;
            this.entries.at(-1).amendment = {
              number: this.amendCount,
              resultHash: this.entries.at(-1).settled.hash,
            };
            if (behavior.amend) await behavior.amend(this, packet);
            else this.settle(packet);
          },
          async call(args) {
            if (args[0] === "stop")
              this.entries.find((run) => run.id === args[1]).state = "stopped";
            return "";
          },
        });
        clients.set(id, client);
      }
      return clients.get(id);
    },
  });
  t.after(async () => {
    await agent.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
  });
  const { sessionId } = await agent.dispatch("session/new", { cwd: home, mcpServers: [] });
  return {
    agent,
    clients,
    updates,
    home,
    sessionId,
    launched,
    prompt: (text = "Build the change") =>
      agent.dispatch("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
  };
}

NodeTest.default(
  "kept advisor completes on settlement and follow-up amends the same run",
  async (t) => {
    const f = await fixture(t);
    NodeAssert.deepEqual(await f.prompt(), { stopReason: "end_turn" });
    const first = f.updates.find(
      (event) => event.params.update.sessionUpdate === "agent_message_chunk",
    ).params.update.content.text;
    NodeAssert.deepEqual(await f.prompt("Now review it"), { stopReason: "end_turn" });
    const client = f.clients.get(f.sessionId);
    NodeAssert.equal(client.spawnCount, 1);
    NodeAssert.equal(client.amendCount, 1);
    NodeAssert.notEqual(client.output, first);
    NodeAssert.equal(client.entries[0].state, "running");
  },
);

NodeTest.default("old settlement cannot complete an amended prompt", async (t) => {
  let amended;
  const ready = new Promise((resolve) => {
    amended = resolve;
  });
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, {
    async amend(client, packet) {
      amended();
      void gate.then(() => client.settle(packet));
    },
  });
  await f.prompt();
  let completed = false;
  const second = f.prompt("Second request").then(() => {
    completed = true;
  });
  await ready;
  NodeAssert.equal(completed, false);
  finish();
  await second;
  NodeAssert.equal(
    f.updates.filter((event) => event.params.update.sessionUpdate === "agent_message_chunk").length,
    2,
  );
});

NodeTest.default(
  "cancel waits for spawn then stops the owned tree, leaving unrelated workers alone",
  async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entering;
    const started = new Promise((resolve) => {
      entering = resolve;
    });
    const f = await fixture(t, {
      hold: true,
      beforeSpawn() {
        entering();
        return gate;
      },
    });
    const prompt = f.prompt();
    await started;
    const client = f.clients.get(f.sessionId);
    const cancel = f.agent.dispatch("session/cancel", { sessionId: f.sessionId });
    release();
    await f.launched;
    client.entries.push(
      { id: "b-child", state: "running", parent: { mailbox: "a-1" } },
      { id: "outside", state: "running", parent: { mailbox: "someone-else" } },
    );
    await cancel;
    NodeAssert.deepEqual(await prompt, { stopReason: "cancelled" });
    NodeAssert.equal(client.entries.find((run) => run.id === "b-child").state, "stopped");
    NodeAssert.equal(client.entries.find((run) => run.id === "outside").state, "running");
  },
);

NodeTest.default(
  "concurrent prompt is rejected; blocked or stalled execution is an error",
  async (t) => {
    const f = await fixture(t, { hold: true });
    const first = f.prompt();
    await f.launched;
    await NodeAssert.rejects(f.prompt("duplicate"), /already running/);
    f.clients.get(f.sessionId).entries[0].state = "stalled";
    await NodeAssert.rejects(first, /advisor stalled/);
    NodeAssert.equal(f.clients.get(f.sessionId).entries[0].state, "stopped");
  },
);

NodeTest.default(
  "sessions persist, replay conversation and reject cross-workspace loads",
  async (t) => {
    const f = await fixture(t);
    await f.prompt();
    const saved = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.home, "sessions", `${f.sessionId}.json`), "utf8"),
    );
    NodeAssert.equal(saved.history.length, 2);
    const other = new CrewAcpAgent({ home: f.home });
    await NodeAssert.rejects(
      other.dispatch("session/load", { sessionId: f.sessionId, cwd: f.home }),
      /already open/,
    );
    await f.agent.close();
    const updates = [];
    other.notify = (event) => updates.push(event);
    other.client = () => ({ async stopTree() {} });
    await NodeAssert.rejects(
      other.dispatch("session/load", { sessionId: f.sessionId, cwd: NodeOS.tmpdir() }),
      /different workspace/,
    );
    await other.dispatch("session/load", { sessionId: f.sessionId, cwd: f.home });
    NodeAssert.equal(updates.length, 2);
    await other.close();
  },
);

NodeTest.default("rejects unsupported attachments and path traversal", async (t) => {
  const f = await fixture(t);
  await NodeAssert.rejects(
    f.agent.dispatch("session/prompt", {
      sessionId: f.sessionId,
      prompt: [{ type: "image", data: "abc" }],
    }),
    /unsupported/,
  );
  await NodeAssert.rejects(
    f.agent.dispatch("session/load", { sessionId: "../../elsewhere", cwd: f.home }),
    /Invalid CrewCode/,
  );
  NodeAssert.equal(f.clients.size, 0);
});

NodeTest.default(
  "environment isolation preserves credentials and Crew routing without inheriting parent identity",
  () => {
    const env = crewEnvironment("example", {
      PATH: "/bin",
      CREW_RUN: "old",
      CODEX_THREAD_ID: "old",
      HERDR_PANE_ID: "old",
      CREW_HOME: "/tmp/crew",
      CREW_ROUTER: "on",
      OPENAI_API_KEY: "test",
    });
    NodeAssert.deepEqual(env, {
      PATH: "/bin",
      CREW_HOME: "/tmp/crew",
      CREW_ROUTER: "on",
      OPENAI_API_KEY: "test",
      CREW_MAILBOX: "codex-crewcode-example",
    });
  },
);

NodeTest.default(
  "stdio handles malformed JSON and notifications without fake responses",
  async (t) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-protocol-"));
    t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk;
    });
    const server = serve(input, output, { home });
    input.write(
      'broken\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n',
    );
    input.end();
    await server.done;
    const responses = text.trim().split("\n").map(JSON.parse);
    NodeAssert.equal(responses.length, 2);
    NodeAssert.equal(responses[0].error.code, -32700);
    NodeAssert.equal(responses[1].result.protocolVersion, 1);
  },
);

NodeTest.default("setup selects Crew and preserves subsequent user settings", async (t) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-setup-"));
  t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
  const first = await setup({ home, crewBin: "crew" });
  const before = await NodeFSP.readFile(first.path, "utf8");
  await setup({ home, crewBin: "crew" });
  NodeAssert.equal(await NodeFSP.readFile(first.path, "utf8"), before);
  const edited = JSON.parse(before);
  edited.providerInstances.crew.displayName = "My Crew";
  edited.providerInstances.crew.enabled = false;
  edited.providerInstances.crew.config.customModels = ["crew-auto", "custom"];
  await NodeFSP.writeFile(first.path, JSON.stringify(edited));
  await setup({ home });
  NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(first.path, "utf8")), edited);
  NodeAssert.deepEqual(first.settings.defaultModelSelection, {
    instanceId: "crew",
    model: "crew-auto",
  });
  await NodeAssert.rejects(setup({ home, crewBin: "different-crew" }), /Existing settings/);
});
