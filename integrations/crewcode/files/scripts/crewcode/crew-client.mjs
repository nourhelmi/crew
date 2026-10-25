import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const resultHash = (text) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

export function crewEnvironment(sessionId, inherited = process.env) {
  const env = { ...inherited, CREW_MAILBOX: `codex-crewcode-${sessionId}` };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("HERDR_") ||
      [
        "CREW_RUN",
        "CODEX_THREAD_ID",
        "CREW_CODEX_SOCKET",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_SESSION_ID",
        "CREW_OPENCODE_SESSION",
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export class CrewClient {
  constructor(sessionId, { env = process.env, command = env.CREWCODE_CREW_BIN || "crew" } = {}) {
    this.env = crewEnvironment(sessionId, env);
    this.command = command;
    this.home = env.CREW_HOME || NodePath.join(NodeOS.homedir(), ".crew");
  }

  call(args, input = "") {
    return new Promise((resolve, reject) => {
      const child = NodeChildProcess.execFile(
        this.command,
        args,
        {
          env: this.env,
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(`Crew ${args[0]} failed: ${(stderr || error.message).trim()}`));
          else resolve(stdout);
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  async spawn(cwd, packet, name) {
    return JSON.parse(
      await this.call(
        ["spawn", "--role", "advisor", "--keep", "--json", "--cwd", cwd, "--name", name],
        packet,
      ),
    );
  }

  async amend(id, packet) {
    await this.call(["amend", id], packet);
  }

  async runs() {
    let entries;
    try {
      entries = await NodeFSP.readdir(NodePath.join(this.home, "runs"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const runs = await Promise.all(
      entries.map(async (id) => {
        try {
          return JSON.parse(
            await NodeFSP.readFile(NodePath.join(this.home, "runs", id, "meta.json"), "utf8"),
          );
        } catch (error) {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }
      }),
    );
    return runs.filter(Boolean);
  }

  async result(id) {
    try {
      return await NodeFSP.readFile(NodePath.join(this.home, "runs", id, "result.md"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  tree(runs) {
    const parents = new Set([this.env.CREW_MAILBOX]);
    const owned = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of runs) {
        if (!parents.has(run.id) && parents.has(run.parent?.mailbox)) {
          owned.push(run);
          parents.add(run.id);
          changed = true;
        }
      }
    }
    return owned;
  }

  async stopTree() {
    // Parent first prevents further fan-out. Re-read after stopping for children
    // whose launch raced with cancellation. Never stop another ACP session's work.
    const stopped = new Set();
    const errors = [];
    for (let pass = 0; pass < 8; pass++) {
      const pending = this.tree(await this.runs()).filter((run) => !stopped.has(run.id));
      if (!pending.length) {
        if (errors.length)
          throw new AggregateError(
            errors,
            "Could not stop every Crew worker; inspect crew ls --all.",
          );
        return;
      }
      for (const run of pending) {
        try {
          await this.call(["stop", run.id]);
        } catch (error) {
          errors.push(error);
        }
        stopped.add(run.id);
      }
    }
    throw new Error(
      "Crew is still creating descendants after cancellation; inspect crew ls --all.",
    );
  }
}
