import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootEnv } from './console-controller.ts';
import { consoleArgsHash, ConsoleError, metaPath, readMeta, readReceipt, readView, receiptPath, receipts, sessionDir, writeView } from './console-store.ts';
import type { ConsoleMeta, ConsoleReceipt, ConsoleView } from './console-store.ts';
import type { ConsoleHostAdapter, HostCallbacks, HostEvent, HostFactory } from './console-host.ts';
import type { ConsoleAnswer, ConsoleCommand, ConsoleEvent, ConsoleState } from './console-types.ts';
import { hasWaiter, home, loadConfig, mailDir, readJson, readRun, unread, updateRun, withLock, withLockAsync, writeJson } from './store.ts';
import { retireRoot, stopRun } from './retire.ts';
import { childRun, managedConsoleParent, ownedChild } from './console-children.ts';
import { ROOT, writableRoots } from './spawn.ts';
import { processExists, terminateOwnedProcess } from './console-process.ts';

/** One detached owner owns every provider pipe and durable view write. HTTP listeners own none. */
export class ConsoleSupervisor {
  readonly id: string;
  readonly root: string;
  private meta: ConsoleMeta;
  private view: ConsoleView;
  private epoch = randomBytes(24).toString('hex');
  private ownerFile: string;
  private adapter: ConsoleHostAdapter | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private generation = 0;
  private recoveryRequestId: string | undefined;
  private factory: HostFactory | undefined;
  private eventKeys = new Map<string, string>();
  private onExit: () => void;
  constructor(id: string, options: { root?: string; factory?: HostFactory; onExit?: () => void } = {}) {
    this.id = id; this.root = options.root ?? home(); this.factory = options.factory; this.onExit = options.onExit ?? (() => {});
    const meta = readMeta(id, this.root); const view = readView(id, this.root);
    if (!meta || !view) throw new ConsoleError('Managed session state is unavailable.', 404, 'STATE_UNAVAILABLE');
    if (meta.args) { meta.argsHash ??= consoleArgsHash(meta.args); delete meta.args; }
    this.meta = meta; this.view = view; this.ownerFile = join(sessionDir(id, this.root), 'owner.json');
  }
  private own(): boolean {
    return withLock(`console-owner-${this.id}`, () => {
      const owner = readJson<{ pid: number; epoch: string }>(this.ownerFile);
      if (owner) {
        try { if (processExists(owner.pid)) return false; } catch { return false; } // Uncertain ownership stays closed.
        try { unlinkSync(this.ownerFile); } catch { /* competing recovery */ }
      }
      try { writeFileSync(this.ownerFile, JSON.stringify({ pid: process.pid, epoch: this.epoch }), { flag: 'wx', mode: 0o600 }); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    });
  }
  async start(): Promise<boolean> {
    if (!this.own()) return false;
    this.meta.pid = process.pid; this.meta.epoch = this.epoch; this.heartbeat();
    // Recovered roots require explicit resume. Never replay a launch/message whose owner disappeared.
    const commands = receipts(this.id, this.root);
    const recovery = commands.filter(r => r.phase === 'pending' && r.intent.kind === 'action' && ['resume', 'close'].includes(r.intent.payload.action)).at(-1);
    this.recoveryRequestId = recovery?.requestId;
    if (this.meta.identity || commands.some(r => r.phase === 'attempted')) {
      for (const r of commands) {
        if ((r.phase !== 'complete' || r.command.state === 'queued') && r !== recovery) this.finish(r, 'uncertain', 'Previous owner disappeared; this input may have been accepted. It will not be replayed.');
      }
      this.clearRequests();
      if (this.view.session.state !== 'closed') this.state('disconnected', 'Resume explicitly to recover the exact recorded provider session.');
    }
    this.timer = setInterval(() => { this.heartbeat(); void this.tick(); }, 150);
    this.timer.unref();
    await this.tick();
    return true;
  }
  private persist(): void {
    writeView(this.id, this.view, this.root);
    if (this.eventKeys.size > 3000) {
      const retained = new Set(this.view.events.map(event => event.id));
      for (const [key, id] of this.eventKeys) if (!retained.has(id)) this.eventKeys.delete(key);
    }
  }
  private heartbeat(): void {
    if (this.closed) return;
    this.meta.heartbeat = Date.now(); writeJson(metaPath(this.id, this.root), this.meta);
  }
  private state(state: ConsoleState, error?: string): void {
    if (this.closed && state !== 'closed') return;
    if (this.view.session.state !== state || this.view.session.error !== error) this.view.session.revision++;
    this.view.session.state = state; this.view.session.updatedAt = new Date().toISOString();
    if (error) this.view.session.error = error.slice(0, 2000); else delete this.view.session.error;
    this.persist();
  }
  private event(event: HostEvent): void {
    const { key, ...payload } = event;
    const safe = { ...payload };
    if ('text' in safe) safe.text = safe.text.slice(0, 24_000);
    if ('title' in safe) safe.title = safe.title.slice(0, 256);
    const previous = key ? this.view.events.find(e => e.id === this.eventKeys.get(key)) : undefined;
    if (previous) Object.assign(previous, safe);
    else {
      const sequence = ++this.view.sequence;
      const id = `${this.id}-${sequence}`;
      this.view.events.push({ ...safe, id, sequence, at: new Date().toISOString() } as ConsoleEvent);
      if (key) this.eventKeys.set(key, id);
    }
    this.persist();
  }
  private command(requestId: string, state: ConsoleCommand['state'], error?: string): void {
    const receipt = readReceipt(this.id, requestId, this.root);
    const command: ConsoleCommand = { requestId, state, ...(error ? { error: error.slice(0, 2000) } : {}) };
    if (receipt) { receipt.command = command; writeJson(receiptPath(this.id, requestId, this.root), receipt); }
    Object.defineProperty(this.view.commands, requestId, { value: command, enumerable: true, writable: true, configurable: true });
    for (const event of this.view.events) if (event.kind === 'user' && event.command?.requestId === requestId) event.command = command;
    this.persist();
  }
  private finish(receipt: ConsoleReceipt, state: ConsoleCommand['state'], error?: string): void {
    const live = readReceipt(this.id, receipt.requestId, this.root)?.command;
    error ??= live?.state === state ? live.error : undefined;
    receipt.phase = 'complete'; receipt.command = { requestId: receipt.requestId, state, ...(error ? { error: error.slice(0, 2000) } : {}) };
    writeJson(receiptPath(this.id, receipt.requestId, this.root), receipt);
    this.command(receipt.requestId, state, error);
  }
  private clearRequests(): void {
    if (!this.view.requests.length) return;
    this.view.requests = []; this.view.session.pendingRequests = 0; this.view.session.revision++; this.persist();
  }
  private callbacks(generation: number): HostCallbacks {
    const live = (): boolean => generation === this.generation && !this.closed;
    return {
      identity: identity => {
        if (!live()) return;
        if (this.meta.identity && this.meta.identity.sessionId !== identity.sessionId) throw new ConsoleError('Provider changed the exact recorded session identity.', 409, 'IDENTITY_MISMATCH');
        if (this.meta.child) {
          const run = updateRun(this.meta.child.runId, current => {
            if (current.sessionId && current.sessionId !== identity.sessionId) throw new ConsoleError('Provider changed the retained child identity.', 409, 'IDENTITY_MISMATCH');
            return { ...current, sessionId: identity.sessionId, ...(this.meta.launch.host === 'codex' ? { threadId: identity.sessionId } : {}) };
          });
          if (!run) throw new ConsoleError('Managed child is unavailable.', 409, 'CHILD_NOT_FOUND');
        }
        this.meta.identity = { ...identity, ...(identity.provider ? {} : this.meta.identity?.provider ? { provider: this.meta.identity.provider } : {}) }; this.heartbeat();
      },
      state: (state, error) => {
        if (!live()) return;
        if (['idle', 'interrupted', 'disconnected', 'failed', 'closed'].includes(state)) this.clearRequests();
        this.state(this.meta.mailPaused && ['idle', 'running'].includes(state) ? 'interrupted' : state, error);
      },
      event: event => { if (live()) this.event(event); },
      request: request => {
        if (!live()) return;
        if (this.view.requests.length >= 50 && !this.view.requests.some(r => r.id === request.id)) return;
        this.view.requests = [...this.view.requests.filter(r => r.id !== request.id), request];
        this.view.session.pendingRequests = this.view.requests.length; this.view.session.revision++; this.state('waiting');
      },
      cancelRequest: id => {
        if (!live()) return;
        this.view.requests = this.view.requests.filter(r => r.id !== id);
        this.view.session.pendingRequests = this.view.requests.length; this.view.session.revision++;
        if (!this.view.requests.length && this.view.session.state === 'waiting') this.state('running'); else this.persist();
      },
      command: (requestId, state, error) => { if (live()) this.command(requestId, state, error); },
    };
  }
  private async connect(): Promise<void> {
    const args = loadConfig().args[this.meta.launch.host];
    if (this.meta.argsHash && this.meta.argsHash !== consoleArgsHash(args)) throw new ConsoleError('Native host configuration changed. Restore the recorded configuration or start a new session.', 409, 'HOST_CONFIG_CHANGED');
    const generation = ++this.generation;
    const current = (): void => {
      if (this.closed || this.meta.retiring || generation !== this.generation) throw new ConsoleError('Session was retired during provider connection.', 409, 'SESSION_RETIRED');
      if (this.meta.child) {
        const run = childRun(this.meta.child.runId, this.root);
        if (!run || run.state === 'stopped' || !ownedChild(run, this.root) || managedConsoleParent(run.parent, this.root)?.id !== this.meta.child.rootSessionId) throw new ConsoleError('Child ancestry was retired or disconnected.', 409, 'SESSION_RETIRED');
      }
    };
    current(); const previous = this.adapter; this.adapter = undefined;
    if (previous) await previous.close();
    else if (this.meta.identity?.provider) await terminateOwnedProcess(this.meta.identity.provider);
    current();
    this.clearRequests(); this.eventKeys.clear(); this.state('starting');
    let factory = this.factory;
    if (!factory) factory = this.meta.launch.host === 'codex' ? (await import('./console-codex.ts')).createCodexHost : (await import('./console-claude.ts')).createClaudeHost;
    current();
    const childArgs = this.meta.child && this.meta.launch.host === 'claude' ? [...args, ...[...writableRoots(this.meta.launch.cwd), ROOT].flatMap(root => ['--add-dir', root])] : args;
    this.adapter = factory({ launch: this.meta.launch, instructions: this.meta.instructions, args: childArgs,
      env: { ...rootEnv(), CREW_HOME: this.root, CREW_CONSOLE_SESSION: this.meta.child?.rootSessionId ?? this.id, ...(this.meta.child ? { CREW_RUN: this.meta.child.runId } : {}) },
      ...(this.meta.child ? { child: { runId: this.meta.child.runId } } : {}), callbacks: this.callbacks(this.generation), ...(this.meta.identity ? { identity: this.meta.identity } : {}) });
    await this.adapter.start();
    current();
  }
  private validateAnswer(answer: ConsoleAnswer): void {
    const pending = this.view.requests.find(r => r.id === answer.pendingRequestId);
    if (!pending) throw new ConsoleError('Approval or question was canceled.', 409, 'STALE_REQUEST');
    if (pending.kind === 'approval') {
      if (!answer.option || answer.answers || !pending.options.some(o => o.id === answer.option)) throw new ConsoleError('Invalid approval option.');
    } else {
      if (!answer.answers || answer.option) throw new ConsoleError('Question answers are required.');
      const questions = pending.questions;
      if (Object.keys(answer.answers).some(id => !questions.some(q => q.id === id)) || questions.some(q => answer.answers![q.id] === undefined)) throw new ConsoleError('Answer the current questions.');
      for (const q of questions) {
        const a = answer.answers[q.id];
        if (Array.isArray(a) && !q.multiSelect) throw new ConsoleError('This question requires one answer.');
      }
    }
  }
  private async process(receipt: ConsoleReceipt): Promise<void> {
    receipt.phase = 'attempted'; receipt.owner = this.epoch;
    writeJson(receiptPath(this.id, receipt.requestId, this.root), receipt);
    this.command(receipt.requestId, 'queued');
    try {
      const intent = receipt.intent;
      if (intent.kind === 'launch') {
        if (this.meta.identity) throw new ConsoleError('A recorded launch cannot be replayed.', 409, 'ALREADY_LAUNCHED');
        this.event({ kind: 'user', text: intent.payload.prompt, command: receipt.command });
        await this.connect();
        this.finish(receipt, await this.adapter!.send(intent.payload.prompt, receipt.requestId));
      } else if (intent.kind === 'message') {
        if (!this.adapter || ['closed', 'failed', 'disconnected'].includes(this.view.session.state)) throw new ConsoleError('Session transport is unavailable.', 409, 'SUPERVISOR_UNAVAILABLE');
        this.event({ kind: 'user', text: intent.payload.text, command: receipt.command });
        this.meta.mailPaused = false; this.heartbeat();
        this.finish(receipt, await this.adapter.send(intent.payload.text, receipt.requestId, intent.payload.interrupt));
      } else if (intent.kind === 'answer') {
        this.validateAnswer(intent.payload);
        if (!this.adapter) throw new ConsoleError('Provider is disconnected.', 409, 'SUPERVISOR_UNAVAILABLE');
        await this.adapter.answer(intent.payload); this.finish(receipt, 'delivered');
      } else {
        if (receipt.requestId !== this.recoveryRequestId && intent.payload.revision !== this.view.session.revision) throw new ConsoleError('Session changed before this action could run.', 409, 'STALE_REVISION');
        const action = intent.payload.action;
        if (action === 'close') {
          await this.close(); this.finish(receipt, 'delivered');
        } else if (action === 'interrupt') {
          if (!this.adapter) throw new ConsoleError('Provider is disconnected.', 409, 'SUPERVISOR_UNAVAILABLE');
          this.meta.mailPaused = true; this.heartbeat();
          await this.adapter.interrupt(); this.finish(receipt, 'delivered');
        } else {
          if (!this.meta.identity?.sessionId) throw new ConsoleError('No exact provider identity is recorded.', 409, 'IDENTITY_UNAVAILABLE');
          if (!['idle', 'interrupted', 'disconnected', 'failed'].includes(this.view.session.state)) throw new ConsoleError('Interrupt before resuming.', 409, 'UNSUPPORTED_ACTION');
          this.meta.mailPaused = false; this.heartbeat();
          await this.connect(); this.event({ kind: 'status', text: 'Resumed the recorded provider session. Send a message to continue.' }); this.finish(receipt, 'delivered');
        }
      }
    } catch (error) {
      if (error instanceof ConsoleError) {
        receipt.error = { message: error.message, status: error.status, code: error.code };
        this.finish(receipt, 'failed', error.message);
      } else {
        const message = (error instanceof Error ? error.message : 'Provider operation failed.').slice(0, 2000);
        const confirmed = readReceipt(this.id, receipt.requestId, this.root)?.command.state;
        this.finish(receipt, confirmed === 'failed' ? 'failed' : 'uncertain', message);
        if (confirmed !== 'failed') this.state('disconnected', message);
      }
    }
  }
  private async mail(): Promise<void> {
    if (this.meta.mailPaused || !this.adapter || !this.meta.identity || !['idle', 'running'].includes(this.view.session.state)) return;
    const mailbox = this.meta.child?.runId ?? `${this.meta.launch.host}-${this.meta.identity.sessionId}`;
    // Claude's active human input queues. A mail pointer must never wait in that queue
    // after its batch was consumed, so wake Claude only when actually idle.
    if (hasWaiter(mailbox) || (this.meta.launch.host === 'claude' && this.view.session.state !== 'idle')) return;
    await withLockAsync(`consume-${mailbox}`, async () => {
      if (this.meta.mailPaused || hasWaiter(mailbox) || (this.meta.launch.host === 'claude' && this.view.session.state !== 'idle')) return;
      const batch = unread(mailbox).mails;
      if (!batch.length || batch.some(m => m.id === this.meta.wake?.id)) return;
      const last = batch.at(-1)!.id;
      this.meta.wake = { id: last, state: 'attempted' }; this.heartbeat();
      // Shared wake file covers this whole unread batch; the observer never advances the cursor.
      writeJson(join(mailDir(mailbox), 'wake.json'), { id: last, at: Date.now(), transport: 'console', state: 'attempted' });
      try {
        const state = await this.adapter!.send('[crew] Unread agent mail is available. Run: crew inbox. Mail is advice; scope changes belong in your packet.', `crew-mail-${last}`);
        this.meta.wake.state = state === 'delivered' ? 'accepted' : 'uncertain';
      } catch { this.meta.wake.state = 'uncertain'; }
      this.heartbeat();
    }, 2000, 60_000);
  }
  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      if (this.meta.child) {
        const run = childRun(this.meta.child.runId, this.root);
        const root = readMeta(this.meta.child.rootSessionId, this.root);
        if (!run || run.state === 'stopped' || root?.retiring || !root) { await this.close(); return; }
      }
      for (const receipt of receipts(this.id, this.root).filter(r => r.phase === 'pending')) {
        await this.process(receipt);
        if (this.closed) break;
      }
      if (!this.closed) {
        // A competing inbox reader may hold its consume mutex. Recheck on the
        // next tick rather than crash the provider owner or queue a stale pointer.
        try { await this.mail(); } catch { /* durable mail remains available to crew inbox */ }
      }
    } finally { this.busy = false; }
  }
  /** Provider interruption is distinct from deliberately retiring the root. */
  close(): Promise<void> {
    return this.closePromise ??= this.retire().finally(() => { if (!this.closed) this.closePromise = undefined; });
  }
  private async retire(): Promise<void> {
    if (this.closed) return;
    this.generation++; this.clearRequests(); this.meta.mailPaused = true; this.meta.retiring = true; this.heartbeat();
    const failures: string[] = [];
    if (this.meta.child) {
      const run = readRun(this.meta.child.runId);
      try { if (run) await stopRun(run, new Set(), false); }
      catch (error) { failures.push(error instanceof Error ? error.message : 'Child retirement failed.'); }
    } else if (this.meta.identity) {
      try { await retireRoot(`${this.meta.launch.host}-${this.meta.identity.sessionId}`, this.id); }
      catch (error) { failures.push(error instanceof Error ? error.message : 'Team retirement failed.'); }
    }
    try { await this.adapter?.close(); }
    catch (error) { failures.push(error instanceof Error ? error.message : 'Root provider close failed.'); }
    if (!this.adapter && this.meta.identity?.provider) {
      try { await terminateOwnedProcess(this.meta.identity.provider); }
      catch (error) { failures.push(error instanceof Error ? error.message : 'Recorded root provider stop failed.'); }
    }
    if (failures.length) {
      this.state('failed', failures.join('\n'));
      throw new ConsoleError(`Team retirement failed: ${failures.join('\n')}`, 409, 'RETIREMENT_FAILED');
    }
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    {
      this.adapter = undefined;
      for (const receipt of receipts(this.id, this.root)) {
        if (receipt.phase === 'pending' && !(receipt.intent.kind === 'action' && receipt.intent.payload.action === 'close')) this.finish(receipt, 'failed', 'Session was deliberately closed before this input was delivered.');
        else if (receipt.command.state === 'queued' && receipt.phase === 'complete') this.finish(receipt, 'failed', 'Queued input was canceled when the session closed.');
      }
      this.state('closed');
      delete this.meta.pid; delete this.meta.epoch; delete this.meta.heartbeat; writeJson(metaPath(this.id, this.root), this.meta);
      const owner = readJson<{ epoch: string }>(this.ownerFile);
      if (owner?.epoch === this.epoch) { try { unlinkSync(this.ownerFile); } catch { /* already removed */ } }
      this.onExit();
    }
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || !isAbsolute(path)) throw new Error('crew: console supervisor requires an absolute owned session directory');
  const id = basename(path); const root = dirname(dirname(dirname(path)));
  if (resolve(sessionDir(id, root)) !== resolve(path)) throw new Error('crew: invalid console supervisor path');
  let keep: ReturnType<typeof setInterval> | undefined;
  const supervisor = new ConsoleSupervisor(id, { root, onExit: () => { if (keep) clearInterval(keep); } });
  if (!await supervisor.start()) return;
  // Provider stdout is normally a live handle; keep recovery failures controllable too.
  keep = setInterval(() => {}, 60_000);
  if (readView(id, root)?.session.state === 'closed') clearInterval(keep);
  const stop = (): void => { void supervisor.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Console supervisor failed.'}\n`); process.exitCode = 1; });
}
