import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleProviders } from '../src/console-controller.ts';
import { ConsoleError } from '../src/console-store.ts';
import { loadConfig, writeJson } from '../src/store.ts';
import { route } from '../src/route.ts';

async function fixture(run: (f: { root: string; config: string; roster: string }) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'crew-lead-catalog-'));
  const previous = { ...process.env };
  const config = join(root, 'config.json'); const roster = join(root, 'roster.json');
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['codex', 'claude', 'herdr']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  Object.assign(process.env, { CREW_HOME: root, CREW_CONFIG: config, CREW_ROSTER: roster, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PATH: bin });
  writeJson(config, { router: { enabled: false } });
  writeJson(roster, { models: [
    { model: 'codex/gpt-6.1-sol', effort: 'high', roles: ['advisor', 'builder', 'checker'], cost: 0.1, use: 'Workers' },
    { model: 'codex/gpt-6.1-sol', effort: 'xhigh', roles: ['checker'], cost: 0.1, use: 'Review' },
    { model: 'claude/claude-opus-5-5', effort: 'high', roles: ['advisor'], cost: 1, use: 'Lead' },
    { model: 'codex/disabled', effort: 'low', roles: ['builder'], cost: 0, use: 'Disabled', enabled: false },
  ] });
  try { await run({ root, config, roster }); }
  finally { process.env = previous; rmSync(root, { recursive: true, force: true }); }
}

test('manual lead models extend the root catalog without changing worker defaults or routing', async () => {
  await fixture(async ({ config, roster }) => {
    const original = loadConfig(); const rosterBefore = readFileSync(roster, 'utf8');
    const workerBefore = await route({ role: 'builder', task: 'Worker task' }, original);
    const catalogBefore = consoleProviders();
    assert.deepEqual(catalogBefore[0]!.models.map(m => m.id), ['gpt-6.1-sol']);
    writeJson(config, { router: { enabled: false }, leadModels: ['codex/gpt-6-astra@high', 'codex/gpt-6-astra@max'] });
    const catalog = consoleProviders();
    assert.equal(catalog[0]!.available, true);
    assert.deepEqual(catalog[0]!.models, [
      ...catalogBefore[0]!.models,
      { id: 'gpt-6-astra', label: 'gpt-6-astra', efforts: ['high', 'max'] },
    ]);
    assert.deepEqual(catalog[1], catalogBefore[1]);
    const { leadModels, ...workerConfig } = loadConfig();
    assert.deepEqual(leadModels, ['codex/gpt-6-astra@high', 'codex/gpt-6-astra@max']);
    assert.deepEqual(workerConfig, original);
    assert.deepEqual(await route({ role: 'builder', task: 'Worker task' }, loadConfig()), workerBefore);
    assert.equal(readFileSync(roster, 'utf8'), rosterBefore);
  });
});

test('lead aliases and effective efforts deduplicate against each other and roster choices', async () => {
  await fixture(({ config }) => {
    writeJson(config, { leadModels: [
      'gpt-6.1-sol@high', 'openai/gpt-6.1-sol@max', 'codex/gpt-6.1-sol@max',
      'claude-opus-5-5@off', 'anthropic/claude-opus-5-5@low',
      ' gpt-6-astra@max ', 'openai-codex/gpt-6-astra@max',
    ] });
    const catalog = consoleProviders();
    assert.deepEqual(catalog[0]!.models, [
      { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', efforts: ['high', 'xhigh', 'max'] },
      { id: 'gpt-6-astra', label: 'gpt-6-astra', efforts: ['max'] },
    ]);
    assert.deepEqual(catalog[1]!.models, [
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['high', 'low'] },
    ]);
  });
});

test('invalid lead configuration fails explicitly at catalog discovery without breaking worker config', async () => {
  await fixture(async ({ config }) => {
    const defaults = loadConfig().defaults;
    for (const leadModels of [null, {}, 'gpt-6-astra@high', 3]) {
      writeJson(config, { leadModels, router: { enabled: false } });
      assert.deepEqual(loadConfig().defaults, defaults);
      assert.throws(consoleProviders, error => error instanceof ConsoleError && /leadModels must be an array/.test(error.message));
    }
    for (const entry of [null, {}, 3, '', ' ', 'codex/', 'not-a-model', 'gpt-6-astra', 'gpt-6-astra@bogus',
      'gpt-6-astra@high@low', 'codex/gpt 6', 'codex/gpt\0bad', 'opencode/openai/gpt-6-astra@high', `codex/${'x'.repeat(161)}`]) {
      writeJson(config, { leadModels: ['gpt-6-astra@high', entry], router: { enabled: false } });
      assert.deepEqual(loadConfig().defaults, defaults);
      assert.throws(consoleProviders, error => error instanceof ConsoleError && /leadModels\[1\]/.test(error.message));
      assert.equal((await route({ role: 'builder', task: 'Worker task' }, loadConfig())).model, 'gpt-6.1-sol');
    }
  });
});

test('manual leads can populate a missing roster but never claim an unavailable native CLI', async () => {
  await fixture(({ root, config, roster }) => {
    rmSync(roster);
    writeJson(config, { leadModels: ['gpt-6-astra@high', 'opus@max'] });
    process.env.PATH = join(root, 'missing-bin');
    const catalog = consoleProviders();
    assert.deepEqual(catalog.map(p => p.models.map(m => m.id)), [['gpt-6-astra'], ['opus']]);
    assert.ok(catalog.every(p => !p.available && p.reason?.includes('not installed')));
  });
});
