import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Private ownership proof; argv is hashed, never retained or exposed to the browser. */
interface ProcessStamp { pid: number; start: string; fingerprint: string }
export interface OwnedProcess extends ProcessStamp { group: boolean; members?: ProcessStamp[] }
function groupMembers(pid: number): number[] {
  return execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8', timeout: 2000 })
    .trim().split('\n').flatMap(line => {
      const [member, group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith('Z') ? [Number(member)] : [];
    });
}
function stamp(pid: number): { start: string; fingerprint: string } {
  const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim();
  const argv = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 }).trim();
  if (!start || !argv) throw new Error('Provider process ownership could not be recorded.');
  return { start, fingerprint: createHash('sha256').update(argv).digest('hex') };
}
export function recordProcess(pid: number, group: boolean): OwnedProcess {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid owned provider process.');
  const handle: OwnedProcess = { pid, group, ...stamp(pid) };
  if (group && process.platform !== 'win32') {
    const members = groupMembers(pid);
    if (!members.includes(pid)) throw new Error('Provider is not the leader of an owned process group.');
    handle.members = members.filter(member => member !== pid).flatMap(member => {
      try { return [{ pid: member, ...stamp(member) }]; } catch { return []; } // A child can exit during the snapshot.
    });
  }
  return handle;
}
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A zombie has stopped but its parent may not have reaped it yet.
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 2000 }).trim().startsWith('Z');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function processMatches(handle: OwnedProcess): boolean {
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1 || handle.pid === process.pid) return false;
  const live = stamp(handle.pid);
  return live.start === handle.start && live.fingerprint === handle.fingerprint;
}
/** Explicit recovery may stop the recorded orphan, never an unrelated recycled PID. */
export async function terminateOwnedProcess(handle: OwnedProcess): Promise<void> {
  const grouped = handle.group && process.platform !== 'win32';
  const alive = (): boolean => grouped ? groupMembers(handle.pid).length > 0 : processExists(handle.pid);
  const verify = (): void => {
    if (processExists(handle.pid)) {
      if (processMatches(handle)) return;
      throw new Error('Provider process ownership changed. Refusing to stop or resume an unrelated process.');
    }
    // A dead CLI wrapper does not prove its native child exited. A surviving
    // recorded member binds the group to this launch; otherwise fail closed.
    const members = grouped ? groupMembers(handle.pid) : [];
    if (handle.members?.some(member => members.includes(member.pid) && processMatches({ ...member, group: false }))) return;
    throw new Error('Provider wrapper exited with an unverified live process group. Resume is blocked to avoid concurrent session owners.');
  };
  if (!alive()) return;
  verify();
  const signal = (value: NodeJS.Signals): void => {
    if (!alive()) return;
    verify();
    try { process.kill(grouped ? -handle.pid : handle.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 4000;
  const escalate = Date.now() + 1000;
  let killed = false;
  while (alive() && Date.now() < deadline) {
    if (!killed && Date.now() >= escalate) { signal('SIGKILL'); killed = true; }
    await new Promise(r => setTimeout(r, 25));
  }
  if (alive()) throw new Error('Recorded provider did not stop. Resume is blocked to avoid concurrent session owners.');
}
