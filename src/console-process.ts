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
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // The process may exit between kill(0) and ps; other ps failures stay fatal.
    try { process.kill(pid, 0); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return false; }
    throw error;
  }
}
export function processMatches(handle: OwnedProcess): boolean {
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1 || handle.pid === process.pid) return false;
  try {
    const live = stamp(handle.pid);
    return live.start === handle.start && live.fingerprint === handle.fingerprint;
  } catch (error) { if (!processExists(handle.pid)) return false; throw error; }
}

/** Cancel an exec worker including tool shells that started their own process groups. */
export async function terminateOwnedTree(handle: OwnedProcess): Promise<void> {
  if (!handle.group || process.platform === 'win32') throw new Error('Exec cancellation requires verified process-group ownership.');
  const members = groupMembers(handle.pid);
  if (!members.length) return;
  if (processExists(handle.pid)) {
    if (!processMatches(handle)) throw new Error('Provider process ownership changed. Refusing to stop an unrelated process.');
  } else if (!handle.members?.some(member => members.includes(member.pid) && processMatches({ ...member, group: false }))) {
    throw new Error('Provider wrapper exited with an unverified live process group. Stop requires its original owner.');
  }
  const frozen = new Map<number, OwnedProcess>();
  const resumable = new Set<number>();
  const signal = (owned: OwnedProcess, value: NodeJS.Signals): void => {
    if (!processExists(owned.pid)) return;
    if (!processMatches(owned)) throw new Error('Descendant process ownership changed. Refusing to signal a recycled PID.');
    try { process.kill(owned.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  try {
    // Freeze before walking PPIDs: no captured parent may fork or orphan a tool
    // between its snapshot and cancellation. Detached descendants are frozen in
    // turn, then a fresh snapshot closes their own in-flight spawn races.
    process.kill(-handle.pid, 'SIGSTOP');
    for (let pass = 0; ; pass++) {
      const rows = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8', timeout: 2000 })
        .trim().split('\n').map(line => {
          const [pid, parent, group, state] = line.trim().split(/\s+/);
          return { pid: Number(pid), parent: Number(parent), group: Number(group), state: state ?? '' };
        }).filter(row => !row.state.startsWith('Z'));
      let found = false;
      for (const row of rows) {
        if (frozen.has(row.pid) || (row.group !== handle.pid && !frozen.has(row.parent))) continue;
        if (row.pid <= 1 || row.pid === process.pid) throw new Error('Invalid descendant ownership during cancellation.');
        let owned: OwnedProcess;
        try { owned = { pid: row.pid, group: false, ...stamp(row.pid) }; }
        catch (error) { if (!processExists(row.pid)) continue; throw error; }
        frozen.set(row.pid, owned);
        // Original group members were stopped above; restore them on a failed
        // cancellation as well, rather than strand a partially frozen worker.
        if (row.group === handle.pid || !row.state.includes('T')) resumable.add(row.pid);
        signal(owned, 'SIGSTOP');
        found = true;
      }
      if (!found) break;
      if (pass >= 31) throw new Error('Owned process tree did not stabilize for cancellation.');
    }
    // Hard-stop the frozen tree. TERM plus CONT lets a handler spawn a new
    // detached process before exiting, recreating the same orphan race.
    for (const owned of [...frozen.values()].reverse()) signal(owned, 'SIGKILL');
    const deadline = Date.now() + 4000;
    while ([...frozen.values()].some(owned => processExists(owned.pid) && processMatches(owned))) {
      if (Date.now() >= deadline) throw new Error('Owned process descendants did not stop; retry cancellation.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    for (const pid of resumable) {
      const owned = frozen.get(pid)!;
      try { if (processExists(pid) && processMatches(owned)) process.kill(pid, 'SIGCONT'); }
      catch { /* Ownership may have exited while cancellation was completing. */ }
    }
    try {
      const remaining = groupMembers(handle.pid);
      if (remaining.length && (processMatches(handle) || handle.members?.some(member => remaining.includes(member.pid) && processMatches({ ...member, group: false })))) {
        process.kill(-handle.pid, 'SIGCONT');
      }
    } catch { /* Never resume a group whose ownership can no longer be proved. */ }
  }
}
/** Explicit recovery may stop the recorded orphan, never an unrelated recycled PID. */
export async function terminateOwnedProcess(handle: OwnedProcess): Promise<void> {
  if (!handle.group && process.platform !== 'win32') throw new Error('Legacy provider ownership lacks an owned process group. Close it through its original supervisor; recovery is blocked to avoid orphaned native hosts.');
  const grouped = handle.group && process.platform !== 'win32';
  const alive = (): boolean => grouped ? groupMembers(handle.pid).length > 0 : processExists(handle.pid);
  const verify = (): void => {
    if (processExists(handle.pid) && processMatches(handle)) return;
    if (processExists(handle.pid)) {
      throw new Error('Provider process ownership changed. Refusing to stop or resume an unrelated process.');
    }
    // A dead CLI wrapper does not prove its native child exited. A surviving
    // recorded member binds the group to this launch; otherwise fail closed.
    const members = grouped ? groupMembers(handle.pid) : [];
    if (!members.length) return;
    if (handle.members?.some(member => members.includes(member.pid) && processMatches({ ...member, group: false }))) return;
    throw new Error('Provider wrapper exited with an unverified live process group. Resume is blocked to avoid concurrent session owners.');
  };
  if (!alive()) return;
  verify();
  const signal = (value: NodeJS.Signals): void => {
    if (!alive()) return;
    verify();
    try { process.kill(grouped ? -handle.pid : handle.pid, value); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Darwin can return EPERM for a group whose last live member just became
      // a zombie. Confirm retirement; a denied signal to any live member fails.
      if (code !== 'ESRCH' && !(code === 'EPERM' && !alive())) throw error;
    }
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
