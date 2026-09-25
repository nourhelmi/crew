# crew — notes for agents working on this repo

- Zero runtime dependencies. TypeScript runs directly on Node ≥ 24 (type stripping): erasable
  syntax only, `.ts` import specifiers. Check with `npm test && npm run typecheck`.
- `bin/crew` is the only entry point. Plugin caches delegate to `~/.local/bin/crew` (this checkout),
  so CLI changes are live immediately. Skills, agent defs and hook files are copied into the plugin
  caches: bump `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then run
  `node scripts/install.ts`.
- Tests must never touch the user's real herdr, Claude or Codex state: use `CREW_HOME`/`CREW_CONFIG`
  temp dirs and a stub `herdr` on `PATH` (see `test/crew.test.ts`).
- State is plain files in `~/.crew`; every cross-process race is settled by an exclusive-create
  claim file (`runs/<id>/.settled-<hash>`, `.stalled`) or by merging into live metadata
  (`updateRun`). Never write a stale `RunMeta` back.
- Herdr: always pass the run's recorded session (`--session`) and address agents by pane id.
- Codex: hook trust is keyed on the command string, so hook commands must stay version-stable
  (`codex/hooks.json`). `workspace-write` keeps `.git` read-only; spawn grants it via `writable_roots`.
- Claude Code: `/advisor` is a built-in command, so the skill is `/crew:advisor`.
