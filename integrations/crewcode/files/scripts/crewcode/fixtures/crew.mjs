#!/usr/bin/env node
// Test double for the Crew CLI boundary. Never launches a model or touches real state.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command === "spawn" && !/^[a-z][a-z0-9_-]{0,31}$/.test(args[args.indexOf("--name") + 1])) {
  throw new Error("Crew run names must be at most 32 characters.");
}
const id = command === "spawn" ? "a-fixture" : args[0];
const directory = NodePath.join(process.env.CREW_HOME, "runs", id);
const path = NodePath.join(directory, "meta.json");
if (command === "spawn" || command === "amend") {
  NodeFS.mkdirSync(directory, { recursive: true });
  const packet = NodeFS.readFileSync(0, "utf8");
  const result = `# Status\nDONE\n# Evidence\nFixture result for ${packet}\n`;
  const previous = command === "amend" ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : undefined;
  const run = {
    id,
    name: "fixture",
    role: "advisor",
    state: "running",
    sessionId: "fixture-native",
    route: { model: "fixture" },
    parent: { mailbox: process.env.CREW_MAILBOX },
    ...(previous ? { amendment: { number: 1, resultHash: previous.settled.hash } } : {}),
    settled: {
      hash: NodeCrypto.createHash("sha256").update(result).digest("hex").slice(0, 16),
      status: "DONE",
    },
  };
  NodeFS.writeFileSync(NodePath.join(directory, "result.md"), result);
  NodeFS.writeFileSync(path, JSON.stringify(run));
  console.log(command === "spawn" ? JSON.stringify(run) : "amended");
} else if (command === "stop") {
  const run = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  NodeFS.writeFileSync(path, JSON.stringify({ ...run, state: "stopped" }));
  console.log("stopped");
} else {
  console.error(`Unsupported fixture command: ${command}`);
  process.exitCode = 1;
}
