import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, globSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Host, Role, RunMeta, RunState } from './types.ts';

export interface DashboardNode {
  id: string;
  parentId?: string;
  workstreamId: string;
  name: string;
  role: Role | 'root';
  host: Host;
  model?: string;
  effort?: string;
  cwd: string;
  state: RunState | 'untracked';
  launcher?: RunMeta['launcher'];
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  status?: string;
  waitingSince?: string;
  checks?: string;
}

export interface Workstream {
  id: string;
  name: string;
  project: string;
  updatedAt: string;
  runs: number;
  running: number;
  attention: number;
}

export interface DashboardSnapshot {
  nodes: DashboardNode[];
  workstreams: Workstream[];
  warnings: string[];
}

export interface OutputEvent {
  id: string;
  at?: string;
  kind: 'message' | 'tool' | 'result' | 'status';
  title: string;
  text: string;
}

export interface DashboardDetail {
  id: string;
  source: 'codex-session' | 'claude-session' | 'exec-log' | 'unavailable';
  updatedAt?: string;
  truncated: boolean;
  events: OutputEvent[];
  packet: string;
  result: string;
  messages: { at: string; from: string; kind: string; text: string }[];
  warnings: string[];
}

interface Roots { crew: string; codex: string; claude: string }
interface Tail { text: string; truncated: boolean; updatedAt?: string; error?: string }
const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 24_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const HOSTS = new Set(['codex', 'claude', 'opencode']);
const STATES = new Set(['running', 'done', 'blocked', 'failed', 'stalled', 'stopped']);
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const limited = (s: string): string => s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[Output shortened]` : s;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Bounded reads, including on a live append. JSONL never exposes an incomplete record. */
export function readTail(path: string, jsonl = false, limit = MAX_BYTES): Tail {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: '', truncated: false, error: 'Not a regular file' };
    const start = Math.max(0, stat.size - limit);
    const bytes = Buffer.alloc(Math.min(limit, stat.size));
    const count = readSync(fd, bytes, 0, bytes.length, start);
    let data = bytes.subarray(0, count);
    if (jsonl) {
      if (start) data = data.subarray(data.indexOf(10) < 0 ? data.length : data.indexOf(10) + 1);
      data = data.subarray(0, data.lastIndexOf(10) + 1);
    }
    return { text: data.toString('utf8'), truncated: start > 0, updatedAt: iso(stat.mtimeMs) };
  } catch (error) {
    return { text: '', truncated: false, ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { error: 'File could not be read' }) };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function jsonLines(text: string): { value: Record<string, unknown>; raw: string }[] {
  return text.split('\n').filter(Boolean).flatMap(raw => {
    try { return [{ value: record(JSON.parse(raw)), raw }]; } catch { return []; }
  });
}

function outputText(text: string): string {
  // Codex may wrap shell output inside a JSON text block. Decode that known
  // envelope so line breaks remain readable; arbitrary JSON stays unchanged.
  try {
    const value = record(JSON.parse(text));
    if (typeof value.chunk_id === 'string' && typeof value.wall_time_seconds === 'number' && typeof value.output === 'string') {
      const status = typeof value.exit_code === 'number' ? `Exit ${value.exit_code}` : typeof value.session_id === 'number' ? `Running · session ${value.session_id}` : 'Command output';
      return `${status}\n${value.output}`;
    }
  } catch { /* Ordinary output is already displayable. */ }
  return text;
}

function contentText(content: unknown, toolOutput = false): string {
  if (typeof content === 'string') return toolOutput ? outputText(content) : content;
  if (!Array.isArray(content)) return '';
  return content.map(c => {
    const b = record(c);
    const text = b.type === 'text' || b.type === 'output_text' || b.type === 'input_text' ? string(b.text) : '';
    return toolOutput ? outputText(text) : text;
  }).filter(Boolean).join('\n');
}

/** Public messages/tool output only. Ignore hidden reasoning, context injection and mirrored events. */
export function parseOutput(text: string, source: DashboardDetail['source']): OutputEvent[] {
  const events: OutputEvent[] = [];
  for (const { value: row, raw } of jsonLines(text)) {
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 20);
    const at = string(row.timestamp);
    const add = (kind: OutputEvent['kind'], title: string, body: string): void => {
      if (body) events.push({ id: `${id}-${events.filter(e => e.id.startsWith(id)).length}`, ...(at ? { at } : {}), kind, title, text: limited(body) });
    };
    if (source === 'claude-session') {
      const msg = record(row.message);
      if (!Array.isArray(msg.content)) continue;
      for (const value of msg.content) {
        const block = record(value);
        if (row.type === 'assistant' && block.type === 'text') add('message', 'Agent', string(block.text));
        if (row.type === 'assistant' && block.type === 'tool_use') add('tool', string(block.name) || 'Tool', JSON.stringify(block.input ?? {}));
        if (row.type === 'user' && block.type === 'tool_result') add('result', 'Tool output', contentText(block.content));
      }
      continue;
    }
    if (row.type === 'response_item') {
      const p = record(row.payload);
      if (p.type === 'message' && p.role === 'assistant' && p.channel !== 'analysis' && p.phase !== 'analysis') add('message', 'Agent', contentText(p.content));
      if (p.type === 'function_call' || p.type === 'custom_tool_call') add('tool', string(p.name) || 'Tool', string(p.arguments) || string(p.input));
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') add('result', 'Tool output', contentText(p.output, true));
    } else if (source === 'exec-log' && (row.type === 'item.completed' || row.type === 'item.started' || row.type === 'item.updated')) {
      const item = record(row.item);
      if (item.type === 'agent_message') add('message', 'Agent', string(item.text));
      if (item.type === 'command_execution') add('tool', string(item.command) || 'Command', string(item.aggregated_output) || string(item.command));
      if (item.type === 'file_change') add('tool', 'File changes', JSON.stringify(item.changes ?? []));
      if (item.type === 'mcp_tool_call') add('tool', string(item.tool) || 'Tool', JSON.stringify(item.result ?? item.arguments ?? {}));
    } else if (source === 'exec-log' && (row.type === 'error' || row.type === 'turn.failed')) {
      add('status', 'Host error', string(row.message) || string(record(row.error).message));
    }
  }
  return events;
}

function validRun(value: Record<string, unknown>, id: string): value is Record<string, unknown> & RunMeta {
  return value.id === id && typeof value.name === 'string' && ['advisor', 'builder', 'checker'].includes(string(value.role))
    && typeof value.cwd === 'string' && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && STATES.has(string(value.state)) && HOSTS.has(string(record(value.route).host)) && typeof record(value.route).model === 'string'
    && HOSTS.has(string(record(value.parent).host)) && SAFE_ID.test(string(record(value.parent).mailbox));
}

/** A projection only: no mailbox cursors, settlement, processes, host RPCs, or writes. */
export class DashboardObserver {
  readonly roots: Roots;
  private nodes = new Map<string, DashboardNode>();
  private files = new Map<string, string>();
  private scanned = new Map<string, number>();

  constructor(roots: Partial<Roots> = {}) {
    this.roots = {
      crew: roots.crew ?? process.env.CREW_HOME ?? join(homedir(), '.crew'),
      codex: roots.codex ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      claude: roots.claude ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    };
  }

  private transcript(host: Host, sessionId: string | undefined): string | undefined {
    if (!sessionId || !UUID.test(sessionId) || host === 'opencode') return;
    const key = `${host}:${sessionId}`;
    const cached = this.files.get(key);
    if (cached && existsSync(cached)) return cached;
    if (Date.now() - (this.scanned.get(key) ?? 0) < 10_000) return;
    this.scanned.set(key, Date.now());
    const dir = host === 'codex' ? join(this.roots.codex, 'sessions') : join(this.roots.claude, 'projects');
    try {
      const found = globSync(`**/*${sessionId}.jsonl`, { cwd: dir }).sort().at(-1);
      if (found) { const path = join(dir, found); this.files.set(key, path); return path; }
    } catch { /* An absent host directory is represented as unavailable output. */ }
  }

  snapshot(): DashboardSnapshot {
    const warnings: string[] = [];
    const runs = new Map<string, RunMeta>();
    const updated = new Map<string, string>();
    let ids: string[] = [];
    try { ids = readdirSync(join(this.roots.crew, 'runs')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Crew runs could not be read.'); }
    for (const id of ids.filter(id => SAFE_ID.test(id))) {
      const meta = readTail(join(this.roots.crew, 'runs', id, 'meta.json'));
      // Native subagent result folders have no RunMeta and are not Crew runs.
      if (!meta.updatedAt && !meta.error) continue;
      try {
        const value = record(JSON.parse(meta.text));
        if (!validRun(value, id)) throw new Error('Invalid run');
        runs.set(id, value);
        updated.set(id, meta.updatedAt ?? value.createdAt);
      } catch { warnings.push(`Run ${id} has unreadable metadata.`); }
    }
    const titles = new Map(jsonLines(readTail(join(this.roots.codex, 'session_index.jsonl'), true).text)
      .map(({ value }) => [string(value.id), string(value.thread_name)]));
    this.nodes.clear();
    for (const run of runs.values()) {
      const parent = run.parent;
      if (!runs.has(parent.mailbox) && !this.nodes.has(parent.mailbox)) {
        const sessionId = parent.threadId ?? parent.mailbox.replace(/^(claude|codex)-/, '');
        const name = parent.name || titles.get(sessionId) || `${parent.host === 'claude' ? 'Claude Code' : parent.host === 'codex' ? 'Codex' : 'OpenCode'} workstream`;
        this.nodes.set(parent.mailbox, {
          id: parent.mailbox, workstreamId: parent.mailbox, name, role: 'root', host: parent.host,
          cwd: run.cwd, state: 'untracked', ...(UUID.test(sessionId) ? { sessionId } : {}),
          createdAt: run.createdAt, updatedAt: updated.get(run.id)!,
        });
      }
      this.nodes.set(run.id, {
        id: run.id, parentId: parent.mailbox, workstreamId: '', name: run.name, role: run.role, host: run.route.host,
        model: run.route.model, effort: run.route.effort, cwd: run.cwd, state: run.state, launcher: run.launcher,
        ...(run.threadId || run.sessionId ? { sessionId: run.threadId || run.sessionId } : {}),
        createdAt: run.createdAt, updatedAt: updated.get(run.id)!,
        ...(run.settled?.status ? { status: run.settled.status } : {}),
        ...(run.waitingSince ? { waitingSince: run.waitingSince } : {}), ...(run.checks ? { checks: run.checks } : {}),
      });
    }
    for (const node of this.nodes.values()) {
      let root = node;
      const visited = new Set<string>();
      while (root.parentId && this.nodes.has(root.parentId)) {
        if (visited.has(root.id)) { warnings.push(`Cyclic parent relationship for ${node.id}.`); root = node; break; }
        visited.add(root.id); root = this.nodes.get(root.parentId)!;
      }
      node.workstreamId = root.id;
    }
    const groups = new Map<string, Workstream>();
    for (const node of this.nodes.values()) {
      const root = this.nodes.get(node.workstreamId)!;
      let group = groups.get(root.id);
      if (!group) {
        group = { id: root.id, name: root.name, project: basename(root.cwd) || root.cwd, updatedAt: root.updatedAt, runs: 0, running: 0, attention: 0 };
        groups.set(root.id, group);
      }
      if (node.role !== 'root') {
        group.runs++;
        if (node.state === 'running') group.running++;
        if (node.waitingSince || ['blocked', 'stalled', 'failed'].includes(node.state)) group.attention++;
      }
      if (node.updatedAt > group.updatedAt) group.updatedAt = node.updatedAt;
    }
    return { nodes: [...this.nodes.values()], workstreams: [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings };
  }

  detail(id: string): DashboardDetail | undefined {
    const node = this.nodes.get(id);
    if (!node) return;
    const dir = join(this.roots.crew, 'runs', id);
    let path = this.transcript(node.host, node.sessionId);
    let source: DashboardDetail['source'] = path ? node.host === 'codex' ? 'codex-session' : 'claude-session' : 'unavailable';
    if (!path && node.role !== 'root' && existsSync(join(dir, 'exec.log'))) { path = join(dir, 'exec.log'); source = 'exec-log'; }
    const output = path ? readTail(path, true) : { text: '', truncated: false };
    const all = parseOutput(output.text, source);
    const packet = node.role === 'root' ? { text: '', truncated: false } : readTail(join(dir, 'packet.md'));
    const result = node.role === 'root' ? { text: '', truncated: false } : readTail(join(dir, 'result.md'));
    const mail = readTail(join(this.roots.crew, 'mail', id, 'inbox.jsonl'), true);
    const warnings = [output.error, packet.error, result.error, mail.error].filter((s): s is string => Boolean(s));
    if (packet.truncated) warnings.push('Only the end of this large packet is shown.');
    if (result.truncated) warnings.push('Only the end of this large result is shown.');
    if (mail.truncated) warnings.push('Only recent messages are shown.');
    return {
      id, source, ...(output.updatedAt ? { updatedAt: output.updatedAt } : {}),
      truncated: output.truncated || all.length > 100, events: all.slice(-100), packet: packet.text, result: result.text,
      messages: jsonLines(mail.text).slice(-100).map(({ value }) => ({ at: string(value.at), from: string(record(value.from).name) || string(record(value.from).mailbox), kind: string(value.kind), text: limited(string(value.text)) })), warnings,
    };
  }
}
