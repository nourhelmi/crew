import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, scoreCapture, scoreTinyCapture, tinyInstructions, tinyVerifier } from './capture.ts';
import type { LiveCapture, Receipt, Run } from './capture.ts';
import type { Report } from './scenarios.ts';
import { scenarios } from './scenarios.ts';
import { unexecuted } from './score.ts';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface LiveOptions {
  case?: 'cos-integration-reuse' | 'advisor-tiny-repair';
  model: string;
  timeoutMs: number;
  out: string;
  authFile?: string;
  /** Adapter testing or a nonstandard CLI install. No fake is selected by default. */
  codexBin?: string;
}

export function isolatedEnv(base: string, source = process.env): NodeJS.ProcessEnv {
  // Allowlist avoids inherited credentials, sockets, host identity, hooks and NODE_OPTIONS.
  return {
    PATH: `${join(base, 'bin')}:${join(checkout, 'bin')}:${source.PATH ?? '/usr/bin:/bin'}`,
    HOME: join(base, 'home'), CODEX_HOME: join(base, 'codex'), CLAUDE_CONFIG_DIR: join(base, 'claude'),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'), XDG_CACHE_HOME: join(base, 'cache'),
    TMPDIR: join(base, 'tmp'), CREW_HOME: join(base, 'crew'), CREW_CONFIG: join(base, 'config.json'),
    CREW_ROSTER: join(base, 'roster.json'), ADVISOR_STATE_DIR: join(base, 'advisor'),
    CREW_NODE: process.execPath, CREW_NO_DELEGATE: '1', SHELL: '/bin/sh',
    LANG: source.LANG ?? 'en_US.UTF-8', TERM: 'dumb',
  };
}

export function sanitizer(authText = ''): (text: string) => string {
  const secrets: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 8) secrets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  if (authText) visit(JSON.parse(authText));
  return text => {
    for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/("(?:access_token|refresh_token|id_token|OPENAI_API_KEY|api_key|password|secret)"\s*:\s*")[^"\n]*(")/gi, '$1[REDACTED]$2');
  };
}

const executable = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const path = join(dir, name);
    try { accessSync(path, constants.X_OK); return resolve(path); } catch { /* next */ }
  }
  return undefined;
};

// Real host calls and Crew commands remain subprocesses; this shim only records receipts,
// snapshots before assignment, and owned groups. Unused hosts fail closed.
const shim = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const env=process.env,kind=path.basename(process.argv[1]),args=process.argv.slice(2);
const append=(file,value)=>fs.appendFileSync(path.join(env.EVAL_BASE,file),JSON.stringify(value)+'\\n',{mode:0o600});
const walk=(dir)=>{
 const files={}; if(!fs.existsSync(dir))return files;
 for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;
  if(e.isDirectory())Object.assign(files,walk(p));
  else if(e.isFile()&&/\\.(json|md)$/.test(e.name)&&fs.statSync(p).size<200000)files[path.relative(env.EVAL_BASE,p)]=fs.readFileSync(p,'utf8');
 }return files;
};
if(kind!=='crew'&&kind!=='codex'){append('receipts.jsonl',{args:[kind,...args],caller:env.CREW_RUN||'',exitCode:127,stdout:'stubbed unused host',before:{}});process.exit(127);}
if(kind==='codex'&&!['exec','login','--version'].includes(args[0])){console.error('eval: Codex server/daemon controls are disabled');process.exit(127);}
append('owned.jsonl',{pid:process.pid,kind});
const before=kind==='crew'&&['assign','accept'].includes(args[0])?{...walk(path.join(env.EVAL_BASE,'crew','runs')),...walk(path.join(env.EVAL_BASE,'workspace'))}:{};
const target=kind==='crew'?env.EVAL_CREW:env.EVAL_CODEX;
const controlled=kind==='crew'&&args[0]==='connect'?['connect','--socket',path.join(env.EVAL_BASE,'unavailable.sock')]:args;
const child=cp.spawn(target,controlled,{env:{...env,CREW_NO_DELEGATE:'1'},stdio:['inherit','pipe','pipe']});
let stdout='';child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b)});child.stderr.on('data',b=>process.stderr.write(b));
child.on('error',e=>{console.error(e.code||'host launch failed');process.exitCode=127});
child.on('close',(code,signal)=>{
 if(kind==='crew')append('receipts.jsonl',{args,caller:env.CREW_RUN||('codex-'+(env.CODEX_THREAD_ID||'unknown')),exitCode:code??1,stdout,before});
 process.exitCode=code??1;
});
`;

function prompt(base: string, scenario = 'cos-integration-reuse'): string {
  if (scenario === 'advisor-tiny-repair') return `Read ${join(checkout, 'skills/advisor/SKILL.md')} and its worker contract. Act as advisor for this tiny repair using real tools. Work only in ${base}; Crew sources/skills are read-only. Correct greeting.json to message="Hello world", preserve all other fields, run the existing immutable node verify.mjs, and return evidence in root-result.md. Choose staffing proportionally to this tiny task. No personal host state, auth reads, daemon starts, external publishing or unrelated changes. A declared PASS without a correct artifact and actual successful verifier execution does not pass the eval.`;
  return `Read ${join(checkout, 'skills/cos/SKILL.md')} and its referenced advisor, team and handoff contracts first. Act as CoS for this synthetic repo using real tools and Crew, not a JSON plan. Work only in ${base} and read-only Crew skill/CLI sources. All host state is isolated. Do not access personal homes, auth/config contents, external services other than the configured provider, or start daemons. Do not change the eval recorder.\n\nOutcome: publish a shop release from two independent domains: stock correctness and sales reporting. Give each domain useful independent retained advisor ownership and decision latitude, choose their internal solution freely, coordinate interfaces, and integrate delivered evidence. The fixed public output contracts below are acceptance interfaces, not implementation recipes.\n\nStock input is inputs/stock.json (opening tea=10, coffee=5; sold tea=3, coffee=2). Stock deliverable stock/summary.json contains tea, coffee, and owner (the owning advisor's CREW_RUN id). Sales input is inputs/sales.json (three orders worth 600, 500, 600 cents). Sales deliverable sales/summary.json contains grossCents, orders, and owner. Each owner must implement and verify its useful real artifact, not just report PASS. Disjoint directories allow concurrent work. Return evidence in each assigned result, including artifact paths.\n\nIntegrate initial summaries into release.json with tea, coffee, grossCents and orders. Inspect immutable submissions and accept each exact current ref with Crew; grade alone is not acceptance. After initial acceptance, follow up with the existing retained stock owner on a new outcome: support a receipt of two additional tea units from inputs/receipt.json, deliver updated stock/summary.json, and preserve the prior immutable accepted submission. Integrate and accept the new exact result. Use the actual assign/accept/read CLI described in crew --help; do not create another owner for the follow-up. Root owns integration and validates joins, not replaying all owner checks.\n\nFinish only after release.json has tea=9, coffee=3, grossCents=1700, orders=3, all used assignments have exact acceptance, and all descendants are settled/retired. Leave no opaque background agents. No push, deploy, plugin install or unrelated work. Record ownership, refs, integration checks and limitations in root-result.md. The eval independently inspects artifacts, tool receipts, retained session reuse and snapshot integrity; your declared status alone cannot pass it.`;
}

function collect(base: string): LiveCapture {
  const files: Record<string, string> = {};
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || entry.name === '.git') continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(base, path)] = readFileSync(path, 'utf8');
    }
  };
  visit(join(base, 'workspace')); visit(join(base, 'crew', 'runs'));
  // Normalize sandbox paths in all nested fields, preserving text hashes before normalization.
  // Submission Markdown bytes stay exact: only metadata path strings are rebased.
  const rebase = (value: unknown): any => {
    if (typeof value === 'string') return value.startsWith(`${base}/`) ? relative(base, value) : value;
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v)]));
    return value;
  };
  const runs = Object.entries(files).filter(([p]) => /^crew\/runs\/[^/]+\/meta.json$/.test(p)).map(([, v]) => rebase(JSON.parse(v)) as Run);
  const receipts: Receipt[] = existsSync(join(base, 'receipts.jsonl'))
    ? readFileSync(join(base, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => rebase(JSON.parse(line))) : [];
  const childTranscripts = Object.fromEntries(runs.map(r => {
    const path = join(base, 'crew', 'runs', r.id, 'exec.log');
    return [r.id, existsSync(path) ? readFileSync(path, 'utf8') : ''];
  }));
  const rootPath = join(base, 'root.jsonl');
  return { runs, receipts, files, childTranscripts, rootTranscript: existsSync(rootPath) ? readFileSync(rootPath, 'utf8') : '' };
}

function ownedGroups(base: string, rootPid?: number): number[] {
  const pids = new Set<number>(rootPid ? [rootPid] : []);
  const registry = join(base, 'owned.jsonl');
  if (existsSync(registry)) for (const line of readFileSync(registry, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line); if (row.kind === 'codex') pids.add(row.pid);
  }
  const mail = join(base, 'crew', 'mail');
  if (existsSync(mail)) for (const dir of readdirSync(mail)) {
    try { pids.add(Number(readFileSync(join(mail, dir, 'watcher'), 'utf8'))); } catch { /* no watcher */ }
  }
  return [...pids].filter(p => Number.isSafeInteger(p) && p > 1);
}

function signalOwned(base: string, rootPid: number | undefined, signal: NodeJS.Signals): void {
  let processes: string;
  try { processes = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,args='], { encoding: 'utf8' }); }
  catch { return; }
  for (const pid of ownedGroups(base, rootPid)) {
    // A terminated wrapper can leave group members alive. Validate the group, not
    // just its leader, and avoid signalling a recycled recorded pid.
    try {
      const members = processes.split('\n').flatMap(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return match && Number(match[2]) === pid ? [match[3]!] : [];
      });
      if (!members.some(args => args.includes(base) || args.includes('/src/cli.ts watch'))) continue;
      process.kill(-pid, signal);
    } catch { /* gone */ }
  }
}

export async function runLive(options: LiveOptions): Promise<{ report: Report; directory: string }> {
  mkdirSync(options.out, { recursive: true });
  const directory = mkdtempSync(join(resolve(options.out), 'live-'));
  const started = Date.now();
  const scenario = options.case ?? 'cos-integration-reuse';
  const contracts = ['skills/cos/SKILL.md', 'skills/advisor/SKILL.md', 'skills/advisor/references/handoffs.md',
    'skills/advisor/references/team.md', 'codex/hooks.json'];
  let revision = 'unknown';
  try { revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* report unknown */ }
  writeFileSync(join(directory, 'contracts.json'), JSON.stringify({ revision,
    files: contracts.map(path => ({ path, sha256: hash(readFileSync(join(checkout, path), 'utf8')) })),
  }, null, 2) + '\n', { mode: 0o600 });
  const blocked = (note: string): { report: Report; directory: string } => {
    const report: Report = {
      schema: 1, mode: 'live', proof: 'real-provider-tools', model: options.model, status: 'blocked',
      durationMs: Date.now() - started, launchCount: 0, evidencePaths: [],
      cases: scenarios.map(s => ({ ...unexecuted(s), ...(s.id === scenario ? { status: 'blocked' as const } : {}) })), note,
    };
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return { report, directory };
  };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return blocked('Invalid timeout; provider run not executed.');
  if (!options.authFile) return blocked('Missing explicit --codex-auth-file. No real auth was discovered or copied; provider run not executed.');
  const codex = options.codexBin ?? executable('codex');
  if (!codex) return blocked('Codex CLI unavailable; provider run not executed.');
  if (scenario === 'cos-integration-reuse' && !existsSync(join(checkout, 'src', 'assignment.ts'))) return blocked('Assignment runtime not integrated: src/assignment.ts is required.');
  let auth: string;
  try {
    if (!lstatSync(options.authFile).isFile()) return blocked('Auth source must be a regular file, not a symlink.');
    auth = readFileSync(options.authFile, 'utf8');
    const parsed = JSON.parse(auth);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) return blocked('Auth JSON has no credentials.');
  } catch { return blocked('Explicit auth source unavailable or invalid JSON. No provider run executed.'); }
  const sanitize = sanitizer(auth);
  const base = mkdtempSync(join(tmpdir(), 'crew-live-eval-'));
  const env: NodeJS.ProcessEnv = { ...isolatedEnv(base), EVAL_BASE: base, EVAL_CREW: join(checkout, 'bin', 'crew'), EVAL_CODEX: codex };
  let rootPid: number | undefined;
  let failure = '';
  let capture: LiveCapture = { runs: [], receipts: [], files: {}, rootTranscript: '', childTranscripts: {} };
  const stop = () => { failure = 'Interrupted; owned processes stopped and credential copy removed.'; signalOwned(base, rootPid, 'SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'CREW_HOME', 'ADVISOR_STATE_DIR']) mkdirSync(env[key]!, { recursive: true });
    mkdirSync(join(base, 'bin')); mkdirSync(join(base, 'home', '.local', 'bin'), { recursive: true });
    for (const tool of ['crew', 'codex', 'herdr', 'claude', 'opencode', 'agent-router']) writeFileSync(join(base, 'bin', tool), shim, { mode: 0o700 });
    symlinkSync(join(base, 'bin', 'crew'), join(base, 'home', '.local', 'bin', 'crew'));
    writeFileSync(join(base, 'codex', 'auth.json'), auth, { mode: 0o600 });
    writeFileSync(join(base, 'codex', 'hooks.json'), readFileSync(join(checkout, 'codex', 'hooks.json')));
    const model = options.model.replace(/^codex\//, '');
    const args = ['-s', 'workspace-write', '--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([base])}`, '-c', 'shell_environment_policy.inherit="all"',
      '-c', 'check_for_update_on_startup=false'];
    writeFileSync(env.CREW_CONFIG!, JSON.stringify({ router: { enabled: false, command: join(base, 'bin', 'agent-router') },
      defaults: { advisor: `codex/${model}@low`, builder: `codex/${model}@low`, checker: `codex/${model}@low` },
      args: { codex: args, claude: [], opencode: [] }, trust: { roots: [] } }));
    writeFileSync(env.CREW_ROSTER!, JSON.stringify({ models: [{ model: `codex/${model}`, effort: 'low', roles: ['advisor', 'builder', 'checker'], cost: 0, use: 'Explicit isolated eval model.' }] }));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    if (scenario === 'cos-integration-reuse') {
    mkdirSync(join(workspace, 'inputs'));
    writeFileSync(join(workspace, 'inputs', 'stock.json'), JSON.stringify({ opening: { tea: 10, coffee: 5 }, sold: { tea: 3, coffee: 2 } }));
    writeFileSync(join(workspace, 'inputs', 'sales.json'), JSON.stringify([{ totalCents: 600 }, { totalCents: 500 }, { totalCents: 600 }]));
    writeFileSync(join(workspace, 'inputs', 'receipt.json'), JSON.stringify({ tea: 2 }));
    writeFileSync(join(workspace, 'AGENTS.md'), '# Synthetic eval repo\nUse the provided Crew CoS/advisor skills. Real tools only. Confine writes and subprocess state to the isolated sandbox. Shared inputs are immutable; each outcome owner writes its own directory; root writes integration output. No external publishing.\n');
    } else {
      writeFileSync(join(workspace, 'greeting.json'), JSON.stringify({ message: 'Helo world' }));
      writeFileSync(join(workspace, 'verify.mjs'), tinyVerifier);
      writeFileSync(join(workspace, 'AGENTS.md'), tinyInstructions);
    }
    execFileSync('git', ['init', '-q', workspace], { env });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Eval', '-c', 'user.email=eval@invalid', 'add', '.'], { env });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Eval', '-c', 'user.email=eval@invalid', 'commit', '-qm', 'synthetic inputs'], { env });
    writeFileSync(join(base, 'prompt.md'), prompt(base, scenario));
    let authenticated = false;
    try { execFileSync(join(base, 'bin', 'codex'), ['login', 'status'], { env, timeout: 10_000, stdio: 'pipe' }); authenticated = true; }
    catch { failure = 'Isolated Codex login status failed; supplied auth unavailable or unsupported. Provider run not executed.'; }
    if (authenticated) {
      await new Promise<void>((resolveRun, reject) => {
        const child = spawn(join(base, 'bin', 'codex'), ['exec', '--json', '-C', workspace, '--model', model, ...args, '-'],
          { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        rootPid = child.pid;
        const transcript: string[] = [];
        const timer = setTimeout(() => { failure = `Timed out after ${options.timeoutMs}ms; provider workflow incomplete.`; signalOwned(base, rootPid, 'SIGTERM'); }, options.timeoutMs);
        const force = setTimeout(() => signalOwned(base, rootPid, 'SIGKILL'), options.timeoutMs + 1500);
        child.stdout.on('data', b => transcript.push(String(b)));
        child.stderr.on('data', b => transcript.push(String(b)));
        child.once('error', reject);
        child.once('close', code => {
          clearTimeout(timer); clearTimeout(force);
          writeFileSync(join(base, 'root.jsonl'), transcript.join(''), { mode: 0o600 });
          if (code !== 0 && !failure) failure = `Codex root exited ${code}; inspect sanitized transcript.`;
          resolveRun();
        });
        child.stdin.end(prompt(base, scenario));
      });
    }
    capture = collect(base);
    const report = (scenario === 'advisor-tiny-repair' ? scoreTinyCapture : scoreCapture)(capture, options.model, Date.now() - started);
    report.evidencePaths.push('contracts.json');
    if (failure) {
      const authUnavailable = /(?:not logged in|unauthori[sz]ed|authentication (?:failed|required)|invalid api key|token (?:expired|refresh failed)|\b401\b)/i.test(capture.rootTranscript);
      report.status = authenticated && !authUnavailable ? 'fail' : 'blocked';
      report.note = authUnavailable ? 'Provider authentication unavailable; inspect sanitized trace. No model-compliance verdict.' : failure;
      if (report.status === 'blocked') report.cases = scenarios.map(s => ({ ...unexecuted(s), ...(s.id === scenario ? { status: 'blocked' as const } : {}) }));
    }
    // Compute assertions on exact original bytes, then sanitize every persisted byte.
    const save = (path: string, content: string): void => {
      const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
      // Temporary absolute paths are not credentials. Keep them byte-exact so
      // immutable submission digests remain inspectable unless redaction is needed.
      writeFileSync(target, sanitize(content), { mode: 0o600 });
    };
    save('capture.json', JSON.stringify(capture, null, 2)); save('root.jsonl', capture.rootTranscript);
    save('prompt.md', prompt(base, scenario));
    for (const [path, content] of Object.entries(capture.files)) save(path, content);
    for (const [run, text] of Object.entries(capture.childTranscripts)) save(`crew/runs/${run}/exec.jsonl`, text);
    save('report.json', JSON.stringify(report, null, 2) + '\n');
    return { report, directory };
  } catch (error) {
    // Exceptions may carry host output or argv; never expose them unsanitized.
    const result = blocked(`Live adapter failed: ${sanitize(error instanceof Error ? error.message : String(error)).split(base).join('<sandbox>')}`);
    if (rootPid) {
      result.report.status = 'fail';
      result.report.cases = result.report.cases.map(c => c.case === scenario ? { ...c, status: 'fail' } : c);
      writeFileSync(join(directory, 'report.json'), JSON.stringify(result.report, null, 2) + '\n', { mode: 0o600 });
    }
    return result;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    signalOwned(base, rootPid, 'SIGTERM'); await delay(250); signalOwned(base, rootPid, 'SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
}
