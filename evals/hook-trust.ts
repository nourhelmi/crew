import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from './capture.ts';
import { signalOwned } from './live.ts';

const vettedFile = resolve(dirname(fileURLToPath(import.meta.url)), '../codex/hooks.json');
type Hook = {
  key: string; eventName: string; handlerType: 'command'; command: string;
  matcher: string | null; timeoutSec: number; async: boolean;
  sourcePath: string; source: 'user'; pluginId: null; isManaged: false;
  currentHash: string; enabled: boolean; trustStatus: 'untrusted' | 'modified' | 'trusted';
};
export interface HookTrustEvidence {
  sourcePath: string; sourceSha256: string; configPath: string;
  before: Hook[]; after: Hook[];
}

/** Trust only this checkout's exact Crew hooks in a canonical workspace below the isolated base.
 * No thread/model is started. The setup server is closed before the caller launches work.
 * Protocol verified against Codex 0.160.1 HookMetadata and tui/src/hooks_rpc.rs.
 */
export async function setupIsolatedHookTrust(options: {
  base: string; workspace: string; env: NodeJS.ProcessEnv; codexBin: string; vettedHooksFile: string; signal?: AbortSignal;
}): Promise<HookTrustEvidence> {
  const { base, workspace, env, codexBin } = options;
  const sourcePath = join(base, 'codex/hooks.json'), configPath = join(base, 'codex/config.toml');
  if (!workspace.startsWith(`${base}/`)) throw new Error('Hook trust workspace must be inside its owned isolated base.');
  for (const [path, expected] of [[base, base], [workspace, workspace],
    [env.HOME, join(base, 'home')], [env.CODEX_HOME, join(base, 'codex')]] as const) {
    if (!path || path !== expected || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
      throw new Error('Hook trust requires the owned isolated eval home/workspace layout.');
    }
  }
  if (options.vettedHooksFile !== vettedFile || !lstatSync(vettedFile).isFile()) {
    throw new Error('Hook trust source must be this checkout\'s explicitly vetted Crew hooks file.');
  }
  const vetted = readFileSync(vettedFile, 'utf8');
  const checkCopy = (): void => {
    if (!lstatSync(sourcePath).isFile() || readFileSync(sourcePath, 'utf8') !== vetted) {
      throw new Error('Isolated hooks must be a regular exact copy of vetted Crew hooks.');
    }
    try { if (!lstatSync(configPath).isFile()) throw new Error('Hook trust config must be a regular isolated file.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  checkCopy();
  const groups = JSON.parse(vetted).hooks as Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number; async?: boolean }[] }[]>;
  const expected = Object.entries(groups).flatMap(([event, entries]) => entries.flatMap(group => group.hooks.map(hook => ({
    eventName: event[0]!.toLowerCase() + event.slice(1), handlerType: hook.type, command: hook.command,
    matcher: group.matcher ?? null, timeoutSec: hook.timeout, async: hook.async ?? false,
  }))));
  const select = (value: unknown): Hook[] => {
    const data = (value as { data?: { cwd: string; hooks: Hook[]; errors: unknown[]; warnings: unknown[] }[] } | null)?.data;
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.cwd !== workspace
      || !Array.isArray(data[0].hooks) || !Array.isArray(data[0].errors) || data[0].errors.length
      || !Array.isArray(data[0].warnings) || data[0].warnings.length) throw new Error('Hook list omitted the exact clean isolated workspace.');
    const hooks = data[0].hooks;
    if (hooks.length !== expected.length) throw new Error('Hook list did not contain exactly the vetted Crew hooks.');
    const keys = new Set<string>(), used = new Set<number>();
    for (const hook of hooks) {
      const index = expected.findIndex((entry, i) => !used.has(i) && Object.entries(entry).every(([key, value]) => hook?.[key as keyof Hook] === value));
      if (index < 0 || hook.sourcePath !== sourcePath || hook.source !== 'user' || hook.isManaged !== false || hook.pluginId !== null
        || typeof hook.key !== 'string' || !hook.key || hook.key.length > 512 || keys.has(hook.key)
        || typeof hook.currentHash !== 'string' || !hook.currentHash || hook.currentHash.length > 512
        || typeof hook.enabled !== 'boolean' || !['untrusted', 'modified', 'trusted'].includes(hook.trustStatus)) {
        throw new Error('Hook metadata differs from the exact vetted isolated Crew hook contract.');
      }
      keys.add(hook.key); used.add(index);
    }
    // Persist only reviewed fields, never arbitrary hook/config/server payloads.
    return hooks.map(hook => Object.fromEntries(['key', 'eventName', 'handlerType', 'command', 'matcher', 'timeoutSec', 'async',
      'sourcePath', 'source', 'pluginId', 'isManaged', 'currentHash', 'enabled', 'trustStatus'].map(key => [key, hook[key as keyof Hook]])) as Hook);
  };
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  // Include the owned workspace in argv so cleanup can revalidate surviving group
  // members even if the server leader exits before its children.
  const child = spawn(codexBin, ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([workspace])}`,
    'app-server', '--listen', 'stdio://'], { env, cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined, buffer = '', closed = false;
  const fail = (error: Error): void => { failure ??= error; pending?.reject(failure); pending = undefined; };
  const abort = (): void => fail(new Error('Isolated hook trust setup interrupted or timed out.'));
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', () => fail(new Error('Isolated hook trust app-server could not start.')));
  child.once('close', () => { closed = true; fail(new Error('Isolated hook trust app-server disconnected.')); });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => fail(new Error('Isolated hook trust app-server pipe failed.')));
  child.stdout.on('data', bytes => {
    buffer += String(bytes);
    if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(new Error('Hook trust protocol exceeded its frame limit.')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) throw new Error('Unexpected hook setup server request.');
        if (!pending || message.id !== pending.id) continue;
        const call = pending; pending = undefined;
        if (message.error || !Object.hasOwn(message, 'result')) call.reject(new Error('Isolated hook trust RPC rejected.'));
        else call.resolve(message.result);
      } catch { fail(new Error('Invalid isolated hook trust protocol frame.')); }
    }
  });
  const rpc = (method: string, params: object): Promise<unknown> => {
    if (signal.aborted) abort();
    if (failure) return Promise.reject(failure);
    return new Promise((resolveRpc, reject) => {
      pending = { id: ++nextId, resolve: resolveRpc, reject };
      child.stdin.write(JSON.stringify({ id: nextId, method, params }) + '\n');
    });
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'crew_eval_hooks', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const before = select(await rpc('hooks/list', { cwds: [workspace] }));
    checkCopy();
    await rpc('config/batchWrite', { filePath: configPath, edits: [{ keyPath: 'hooks.state',
      value: Object.fromEntries(before.map(hook => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: 'upsert' }], reloadUserConfig: true });
    const after = select(await rpc('hooks/list', { cwds: [workspace] }));
    checkCopy();
    if (after.some(hook => !hook.enabled || hook.trustStatus !== 'trusted'
      || !before.some(previous => previous.key === hook.key && previous.currentHash === hook.currentHash
        && previous.command === hook.command && previous.eventName === hook.eventName))) throw new Error('Vetted Crew hooks were not enabled/trusted unchanged after reload.');
    return { sourcePath, sourceSha256: hash(vetted), configPath, before, after };
  } finally {
    signal.removeEventListener('abort', abort);
    child.stdin.end();
    if (!closed) { signalOwned(base, child.pid, 'SIGTERM'); await delay(250); signalOwned(base, child.pid, 'SIGKILL'); }
    if (!closed) await Promise.race([new Promise<void>(resolveClose => child.once('close', () => resolveClose())), delay(1000)]);
    if (!closed) throw new Error('Owned hook trust app-server did not terminate.');
  }
}
