import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleController, hostCapabilities } from '../src/console-controller.ts';
import { ConsoleSupervisor } from '../src/console-supervisor.ts';
import { writeJson } from '../src/store.ts';
import type { ConsoleHostAdapter, HostFactory } from '../src/console-host.ts';

test('close during resume cannot create a replacement provider after root retirement', async () => {
  const root = mkdtempSync('/private/tmp/crew-console-review-lifecycle-');
  const prior = { ...process.env };
  Object.assign(process.env, { CREW_HOME: root, CREW_CONFIG: join(root, 'config.json'), CREW_ROSTER: join(root, 'roster.json') });
  writeJson(process.env.CREW_CONFIG!, { router: { enabled: false }, args: { codex: [], claude: [] } });
  let unblock!: () => void, closing!: () => void;
  const blocked = new Promise<void>(r => { unblock = r; });
  const entered = new Promise<void>(r => { closing = r; });
  let starts = 0, stops = 0;
  let supervisor: ConsoleSupervisor | undefined;
  const factory: HostFactory = options => {
    const adapter: ConsoleHostAdapter = {
      capabilities: hostCapabilities('codex'),
      async start() { starts++; options.callbacks.identity({ sessionId: 'review-native' }); options.callbacks.state('idle'); },
      async send(_text, id) { options.callbacks.command(id, 'delivered'); return 'delivered'; },
      async interrupt() {}, async answer() {},
      async close() { if (++stops === 1) { closing(); await blocked; } },
    };
    return adapter;
  };
  const controller = new ConsoleController({ root, providers: () => [{ id: 'codex', label: 'Fixture', available: true, models: [], capabilities: hostCapabilities('codex') }],
    startSupervisor: async id => { supervisor = new ConsoleSupervisor(id, { root, factory }); await supervisor.start(); } });
  try {
    const first = await controller.launch({ requestId: 'launch', cwd: root, mode: 'advisor', host: 'codex', prompt: 'first' });
    const resume = controller.action(first.session.id, { requestId: 'resume', action: 'resume', revision: first.session.revision });
    await entered;
    await supervisor!.close();
    unblock(); await assert.rejects(resume, /retired during provider connection/);
    assert.equal(controller.detail(first.session.id)!.session.state, 'closed');
    assert.equal(starts, 1, 'retired root must not start a second native provider');
  } finally {
    unblock(); await supervisor?.close(); process.env = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
