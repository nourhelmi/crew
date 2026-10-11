import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Private ownership proof; argv is hashed, never retained or exposed to the browser. */
export interface OwnedProcess { pid: number; group: boolean; start: string; fingerprint: string }
function stamp(pid: number): { start: string; fingerprint: string } {
  const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim();
  const argv = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 }).trim();
  if (!start || !argv) throw new Error('Provider process ownership could not be recorded.');
  return { start, fingerprint: createHash('sha256').update(argv).digest('hex') };
}
export function recordProcess(pid: number, group: boolean): OwnedProcess {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid owned provider process.');
  return { pid, group, ...stamp(pid) };
}
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function processMatches(handle: OwnedProcess): boolean {
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1 || handle.pid === process.pid) return false;
  const live = stamp(handle.pid);
  return live.start === handle.start && live.fingerprint === handle.fingerprint;
}
/** Explicit recovery may stop the recorded orphan, never an unrelated recycled PID. */
export async function terminateOwnedProcess(handle: OwnedProcess): Promise<void> {
  if (!processExists(handle.pid)) return;
  if (!processMatches(handle)) throw new Error('Provider process ownership changed. Refusing to stop or resume an unrelated process.');
  const signal = (value: NodeJS.Signals): void => {
    if (!processExists(handle.pid)) return;
    if (!processMatches(handle)) throw new Error('Provider process ownership changed during recovery.');
    try { process.kill(handle.group && process.platform !== 'win32' ? -handle.pid : handle.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 4000;
  const escalate = Date.now() + 1000;
  let killed = false;
  while (processExists(handle.pid) && Date.now() < deadline) {
    if (!killed && Date.now() >= escalate) { signal('SIGKILL'); killed = true; }
    await new Promise(r => setTimeout(r, 25));
  }
  if (processExists(handle.pid)) throw new Error('Recorded provider did not stop. Resume is blocked to avoid concurrent session owners.');
}
