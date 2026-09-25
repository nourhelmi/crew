import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import { readJson, writeJson } from './store.ts';

/**
 * Folder-trust dialogs block an agent before it reads its first prompt, and neither CLI
 * inherits trust across git roots. crew records trust per checkout: everything under the
 * configured trust roots (default ~/Dev), plus worktrees of a checkout that is already trusted.
 */

export interface TrustFiles { claude: string; codex: string }
export const TRUST_FILES: TrustFiles = { claude: join(homedir(), '.claude.json'), codex: join(homedir(), '.codex', 'config.toml') };

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const real = (path: string): string => { try { return realpathSync(path); } catch { return resolvePath(path); } };
const git = (cwd: string, arg: string): string | undefined => {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', arg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
  catch { return undefined; }
};

export function mainCheckout(cwd: string): string | undefined {
  const common = git(cwd, '--git-common-dir');
  if (!common) return undefined;
  const dir = resolvePath(cwd, common);
  return basename(dir) === '.git' ? dirname(dir) : undefined;
}

// ---- Claude: ~/.claude.json projects[path].hasTrustDialogAccepted ------------------------

type ClaudeState = { projects?: Record<string, Record<string, unknown>> };

export const claudeTrusted = (state: ClaudeState, path: string): boolean =>
  state.projects?.[path]?.hasTrustDialogAccepted === true;

// ---- Codex: config.toml [projects."<path>"] trust_level = "trusted" ----------------------

const header = (path: string): string => `[projects.${JSON.stringify(path)}]`;

function section(text: string, path: string): { start: number; end: number } | undefined {
  const start = text.split('\n').findIndex(line => line.trim() === header(path));
  if (start < 0) return undefined;
  const lines = text.split('\n');
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith('[')) end++;
  return { start, end };
}

export function codexTrusted(text: string, path: string): boolean {
  const found = section(text, path);
  if (!found) return false;
  return text.split('\n').slice(found.start + 1, found.end).some(line => /^\s*trust_level\s*=\s*"trusted"\s*$/.test(line));
}

/** Set trust_level = "trusted" for each path, editing existing sections in place. */
export function codexTrust(text: string, paths: string[]): string {
  let lines = text.split('\n');
  const appended: string[] = [];
  for (const path of paths) {
    const current = lines.join('\n');
    if (codexTrusted(current, path)) continue;
    const found = section(current, path);
    if (!found) { appended.push('', header(path), 'trust_level = "trusted"'); continue; }
    const body = lines.slice(found.start + 1, found.end);
    const at = body.findIndex(line => /^\s*trust_level\s*=/.test(line));
    if (at >= 0) body[at] = 'trust_level = "trusted"';
    else body.unshift('trust_level = "trusted"');
    lines = [...lines.slice(0, found.start + 1), ...body, ...lines.slice(found.end)];
  }
  let out = lines.join('\n');
  if (appended.length) out = `${out.replace(/\n*$/, '\n')}${appended.join('\n')}\n`;
  return out;
}

// ---- applying -------------------------------------------------------------------------

export interface TrustResult { claude: string[]; codex: string[] }

export function trustPaths(paths: string[], files: TrustFiles = TRUST_FILES): TrustResult {
  const unique = [...new Set(paths.map(real))];
  const result: TrustResult = { claude: [], codex: [] };

  const state = readJson<ClaudeState>(files.claude);
  if (state) {
    for (const path of unique) {
      if (claudeTrusted(state, path)) continue;
      state.projects = { ...state.projects, [path]: { ...state.projects?.[path], hasTrustDialogAccepted: true } };
      result.claude.push(path);
    }
    if (result.claude.length) writeJson(files.claude, state);
  }

  if (existsSync(files.codex)) {
    const text = readFileSync(files.codex, 'utf8');
    result.codex = unique.filter(path => !codexTrusted(text, path));
    if (result.codex.length) writeFileSync(files.codex, codexTrust(text, result.codex));
  }
  return result;
}

const SKIP = new Set(['node_modules', '.venv', 'venv', 'dist', 'build', '.next', 'target', 'vendor', '.cache', '.turbo', 'Pods', 'DerivedData']);

/** Git checkouts (repos and worktrees) under a root, plus the root itself. */
export function checkouts(root: string, maxDepth = 6): string[] {
  const found = [real(root)];
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.name === '.git')) found.push(dir);
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || SKIP.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(real(root), 0);
  return [...new Set(found)];
}

export const underRoots = (path: string, roots: string[]): boolean => roots.some(root => within(real(path), real(root)));

/** What to trust so an agent started in `cwd` gets no dialog, or [] if crew should not decide. */
export function trustTargets(cwd: string, roots: string[], files: TrustFiles = TRUST_FILES): string[] {
  const top = git(cwd, '--show-toplevel');
  const targets = [...new Set([top, cwd].filter((path): path is string => Boolean(path)).map(real))];
  if (underRoots(cwd, roots)) return targets;
  // Outside the roots, a worktree still inherits from its trusted main checkout.
  const main = mainCheckout(cwd);
  if (!main || targets.includes(real(main))) return [];
  const state = readJson<ClaudeState>(files.claude);
  const text = existsSync(files.codex) ? readFileSync(files.codex, 'utf8') : '';
  const mainTrusted = (state && claudeTrusted(state, real(main))) || codexTrusted(text, real(main));
  return mainTrusted ? targets : [];
}
