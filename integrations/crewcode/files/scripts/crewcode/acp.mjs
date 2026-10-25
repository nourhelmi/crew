#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";
import { CrewClient, resultHash } from "./crew-client.mjs";

const models = {
  currentModelId: "crew-auto",
  availableModels: [
    {
      modelId: "crew-auto",
      name: "Crew · automatic routing",
      description: "Your Crew roster and router select the advisor and workers.",
    },
  ],
};
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rpcError = (message, code = -32602) => Object.assign(new Error(message), { code });

export class CrewAcpAgent {
  constructor({
    home = process.env.CREWCODE_HOME || NodePath.join(NodeOS.homedir(), ".crewcode"),
    client = (id) => new CrewClient(id),
    notify = () => {},
    pollMs = 500,
    timeoutMs = 60 * 60_000,
  } = {}) {
    this.home = home;
    this.client = client;
    this.notify = notify;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
    this.active = new Map();
    this.leases = new Map();
    this.closing = false;
  }

  update(sessionId, update) {
    this.notify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  text(sessionId, text, type = "agent_message_chunk") {
    this.update(sessionId, { sessionUpdate: type, content: { type: "text", text } });
  }
  path(id) {
    if (typeof id !== "string" || !sessionPattern.test(id))
      throw rpcError("Invalid CrewCode session ID.");
    return NodePath.join(this.home, "sessions", `${id}.json`);
  }

  async save(session) {
    const path = this.path(session.id);
    await NodeFSP.mkdir(NodePath.join(this.home, "sessions"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  }

  async lease(id) {
    if (this.leases.has(id)) return;
    const path = `${this.path(id)}.lock`;
    let handle;
    try {
      handle = await NodeFSP.open(path, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Do not steal another live bridge's session. A stale lock requires explicit
      // recovery, since PIDs can be reused and two hosts can share storage.
      throw rpcError(`CrewCode session is already open, or has a stale lock: ${path}`, -32000);
    }
    await handle.writeFile(String(process.pid));
    this.leases.set(id, { handle, path });
  }

  async session(id) {
    this.path(id);
    const session = this.sessions.get(id);
    if (!session) throw rpcError("Session is not loaded. Call session/new or session/load first.");
    return session;
  }

  async cwd(value) {
    if (typeof value !== "string" || !NodePath.isAbsolute(value))
      throw rpcError("cwd must be an absolute directory path.");
    try {
      const path = await NodeFSP.realpath(value);
      if (!(await NodeFSP.stat(path)).isDirectory()) throw new Error("not a directory");
      return path;
    } catch {
      throw rpcError("cwd must be an existing directory.");
    }
  }

  async dispatch(method, params = {}) {
    if (this.closing) throw rpcError("CrewCode is shutting down.", -32000);
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentInfo: { name: "crewcode", title: "CrewCode", version: "0.1.0" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
          },
          authMethods: [],
        };
      case "session/new": {
        const session = {
          id: NodeCrypto.randomUUID(),
          cwd: await this.cwd(params.cwd),
          history: [],
        };
        await this.save(session);
        await this.lease(session.id);
        this.sessions.set(session.id, session);
        return { sessionId: session.id, models };
      }
      case "session/load": {
        const path = this.path(params.sessionId);
        if (this.active.has(params.sessionId))
          throw rpcError("Session has an active prompt.", -32000);
        let session;
        try {
          session = JSON.parse(await NodeFSP.readFile(path, "utf8"));
        } catch {
          throw rpcError("CrewCode session was not found or is unreadable.");
        }
        if (session.id !== params.sessionId || !Array.isArray(session.history))
          throw rpcError("Invalid saved session.");
        if (session.cwd !== (await this.cwd(params.cwd)))
          throw rpcError("Cannot load a CrewCode session in a different workspace.");
        await this.lease(session.id);
        this.sessions.set(session.id, session);
        for (const entry of session.history)
          this.text(session.id, entry.text, `${entry.role}_message_chunk`);
        return { models };
      }
      case "session/set_model":
        await this.session(params.sessionId);
        if (params.modelId !== "crew-auto")
          throw rpcError(
            "Crew owns model selection. Choose crew-auto and configure your Crew roster.",
          );
        return {};
      case "session/prompt":
        return this.prompt(params);
      case "session/cancel":
        await this.cancel(params.sessionId);
        return {};
      default:
        throw rpcError(`Unsupported ACP method: ${method}`, -32601);
    }
  }

  promptText(prompt) {
    if (!Array.isArray(prompt) || prompt.length === 0)
      throw rpcError("A nonempty text prompt is required.");
    const text = prompt
      .map((part) => {
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "resource" && typeof part.resource?.text === "string")
          return `${part.resource.uri || "Context"}:\n${part.resource.text}`;
        if (part.type === "resource_link" && typeof part.uri === "string")
          return `[${part.name || "Resource"}] ${part.uri}`;
        throw rpcError(
          "CrewCode currently accepts text and text resources; images and audio are unsupported.",
        );
      })
      .join("\n\n");
    if (!text.trim() || text.length > 512_000)
      throw rpcError("Prompt must contain text and be at most 512,000 characters.");
    return text;
  }

  async prompt(params) {
    const session = await this.session(params.sessionId);
    if (this.closing) throw rpcError("CrewCode is shutting down.", -32000);
    const text = this.promptText(params.prompt);
    if (this.active.has(session.id))
      throw rpcError("A prompt is already running in this session.", -32000);
    const controller = new AbortController();
    const active = { controller, done: undefined };
    this.active.set(session.id, active);
    active.done = this.runPrompt(session, text, controller.signal).finally(() =>
      this.active.delete(session.id),
    );
    return active.done;
  }

  async runPrompt(session, text, signal) {
    const client = this.client(session.id);
    const requestId = NodeCrypto.randomUUID();
    const seen = new Map();
    let previousHash;
    let completed = false;
    try {
      let runs = await client.runs();
      let run = client.tree(runs).find((candidate) => candidate.id === session.runId);
      previousHash = run?.settled?.hash;
      const packet = `${text}\n\nCrewCode turn ID: ${requestId}. Include this ID in your result Evidence so this turn settles independently.\nLead this work using your Crew advisor workflow, route and delegate through crew, and settle your children before reporting.\nYour host's own sandbox and approval rules apply. Do not assume this ACP client grants additional permissions.\n`;
      session.history.push({ role: "user", text });
      await this.save(session);
      if (run && run.state === "running" && (run.sessionId || run.launcher === "herdr")) {
        await client.amend(run.id, packet);
      } else {
        // A stopped run cannot resume; an installation without hooks cannot learn
        // its native session ID. Carry prior conversation into a replacement.
        await client.stopTree();
        if (signal.aborted) return { stopReason: "cancelled" };
        const history = session.history
          .slice(0, -1)
          .map((entry) => `${entry.role}: ${entry.text}`)
          .join("\n\n")
          .slice(-64_000);
        run = await client.spawn(
          session.cwd,
          `${history ? `Previous conversation (context):\n${history}\n\nCurrent request:\n` : ""}${packet}`,
          `crewcode-${requestId.replaceAll("-", "").slice(0, 20)}`,
        );
        if (typeof run.id !== "string" || run.parent?.mailbox !== client.env.CREW_MAILBOX)
          throw new Error("Crew returned a run owned by a different session.");
        session.runId = run.id;
        previousHash = undefined;
        await this.save(session);
      }
      const deadline = Date.now() + this.timeoutMs;
      while (!signal.aborted) {
        runs = await client.runs();
        const owned = client.tree(runs);
        run = owned.find((candidate) => candidate.id === session.runId);
        if (!run) throw new Error("Crew run disappeared; inspect crew ls --all.");
        for (const worker of owned) {
          const freshSettlement =
            worker.settled &&
            (worker.id !== run.id || worker.settled.hash !== previousHash) &&
            worker.settled.hash !== worker.amendment?.resultHash;
          const status =
            ["failed", "stalled", "blocked", "stopped"].includes(worker.state) ||
            (freshSettlement && /^(FAIL|BLOCKED)/i.test(worker.settled.status))
              ? "failed"
              : freshSettlement || worker.state === "done"
                ? "completed"
                : "in_progress";
          const title = `${worker.role} · ${worker.name} · ${worker.route?.model || "Crew"}`;
          const signature = `${status}:${worker.settled?.hash}:${worker.amendment?.number}:${worker.waitingSince}`;
          if (seen.get(worker.id) !== signature) {
            this.update(session.id, {
              sessionUpdate: seen.has(worker.id) ? "tool_call_update" : "tool_call",
              toolCallId: worker.id,
              title: worker.waitingSince ? `${title} · awaiting approval in host CLI` : title,
              kind: "other",
              status,
            });
            seen.set(worker.id, signature);
          }
        }
        const result = await client.result(run.id);
        if (
          run.settled?.hash &&
          run.settled.hash !== previousHash &&
          run.settled.hash !== run.amendment?.resultHash &&
          run.settled.hash === resultHash(result)
        ) {
          this.text(session.id, result);
          session.history.push({ role: "agent", text: result });
          await this.save(session);
          completed = true;
          return { stopReason: "end_turn" };
        }
        if (["failed", "blocked", "stalled", "stopped"].includes(run.state)) {
          throw new Error(
            `Crew advisor ${run.state}. ${result || `Inspect crew read ${run.id} for host output.`}`,
          );
        }
        if (Date.now() >= deadline)
          throw new Error(
            "Crew turn timed out after one hour. Inspect the host CLI for a pending approval or login.",
          );
        await NodeTimersPromises.setTimeout(this.pollMs, undefined, { signal });
      }
      return { stopReason: "cancelled" };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw rpcError(error.message, -32000);
    } finally {
      // Errors and cancellation must not leave an advisor or its workers running.
      if (signal.aborted || !completed) {
        await client.stopTree();
        for (const id of seen.keys())
          this.update(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "failed",
          });
        delete session.runId;
        await this.save(session);
      }
    }
  }

  async cancel(id) {
    await this.session(id);
    const active = this.active.get(id);
    if (!active) return;
    active.controller.abort();
    // Let an in-flight spawn finish before cleaning up; otherwise a detached run
    // could appear after cancellation has already scanned the run directory.
    await active.done;
  }

  async close() {
    this.closing = true;
    const failures = [];
    for (const session of this.sessions.values()) {
      try {
        await this.cancel(session.id);
        await this.client(session.id).stopTree();
        delete session.runId;
        await this.save(session);
      } catch (error) {
        failures.push(error);
      }
    }
    const { unlink } = await import("node:fs/promises");
    for (const { handle, path } of this.leases.values()) {
      await handle.close();
      await unlink(path);
    }
    this.leases.clear();
    this.sessions.clear();
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some Crew runs could not be stopped. Inspect crew ls --all.",
      );
  }
}

export function serve(input = process.stdin, output = process.stdout, options = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const agent = new CrewAcpAgent({ ...options, notify: send });
  const reader = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  const pending = new Set();
  reader.on("line", (line) => {
    let request;
    try {
      if (line.length > 1024 * 1024) throw new Error();
      request = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid or oversized JSON." },
      });
      return;
    }
    if (
      !request ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (request.id !== undefined &&
        typeof request.id !== "string" &&
        typeof request.id !== "number") ||
      (request.params !== undefined &&
        (!request.params || typeof request.params !== "object" || Array.isArray(request.params)))
    ) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request." },
      });
      return;
    }
    const work = (async () => {
      try {
        if (!initialized && request.method !== "initialize")
          throw rpcError("Call initialize first.", -32000);
        if (request.method === "initialize") initialized = true;
        const result = await agent.dispatch(request.method, request.params);
        if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        if (request.id !== undefined)
          send({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: error.code || -32603, message: error.message },
          });
        else process.stderr.write(`CrewCode: ${error.message}\n`);
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  const done = new Promise((resolve, reject) =>
    reader.once("close", () => {
      void (async () => {
        agent.closing = true;
        for (const active of agent.active.values()) active.controller.abort();
        await Promise.all(pending);
        await agent.close();
      })().then(resolve, reject);
    }),
  );
  return { agent, done, stop: () => reader.close() };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const server = serve();
  process.once("SIGINT", server.stop);
  process.once("SIGTERM", server.stop);
  try {
    await server.done;
  } catch (error) {
    console.error(`CrewCode: ${error.message}`);
    process.exitCode = 1;
  }
}
