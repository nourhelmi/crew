# crew — notes for agents working on this repo

- Zero runtime dependencies. TypeScript runs directly on Node ≥ 24 (type stripping): erasable
  syntax only, `.ts` import specifiers. Check with `npm test && npm run typecheck`.
- `bin/crew` is the only entry point. Plugin caches delegate to `~/.local/bin/crew` (this checkout),
  so CLI changes are live immediately. Skills, agent defs and hook files are copied into the plugin
  caches: bump `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then run
  `node scripts/install.ts`.
- Tests must never touch the user's real herdr, Claude or Codex state: use `CREW_HOME`/`CREW_CONFIG`/`CREW_ROSTER`
  temp dirs and a stub `herdr` on `PATH` (see `test/crew.test.ts`).
- State is plain files in `~/.crew`; every cross-process race is settled by an exclusive-create
  claim file (`runs/<id>/.settled-<hash>`, `.stalled`) or by merging into live metadata
  (`updateRun`). Never write a stale `RunMeta` back.
- Herdr: always pass the run's recorded session (`--session`) and address agents by pane id.
  herdr types the launch line into a shell that may still be loading its rc files, where the tty
  keeps only 1024 bytes of a line: instructions go in `runs/<id>/brief.md`, never in argv.
- Compaction drops file reads. Anything a session must keep following lives in a file that the
  SessionStart `compact` branch (`afterCompaction` in `src/hook.ts`) points back to.
- Mail: the inbox is the only content channel. Pushes (`codex queue`, herdr prompts) are one-line
  pointers, one per unread batch, so nothing stale is replayed turn by turn. Children treat plain
  mail as advice; scope changes go through `crew amend`, which appends to the packet.
- Hooks run in every Claude/Codex session on the machine: per-tool-call hooks must exit in the
  shell guard (`$CREW_RUN` unset) before starting node.
- Codex: hook trust is keyed on the command string, so hook commands must stay version-stable
  (`codex/hooks.json`). `workspace-write` keeps `.git` read-only; spawn grants it via `writable_roots`.
- Host-agnostic: user entry points are skills (`skills/<name>/SKILL.md`), never host-specific
  commands, so every Agent Skills host gets them (Claude `/crew:<name>`, Codex `$<name>`, OpenCode
  and others). Host-only frontmatter keys (e.g. Claude's `allowed-tools`) are fine; others ignore them.
- Claude Code: `/advisor` is a built-in command, so the skill is `/crew:advisor`.
- OpenCode has no hooks: `opencode/crew.js` maps its plugin events onto `crew hook …` and wakes its
  own idle sessions from their crew inbox (the TUI serves no port, so nothing outside can push).
- Work goes through `crew spawn`. Inside a crew run, the Claude PreToolUse hook refuses native
  subagents other than read-only Explore/Plan: they inherit the run's model and skip routing,
  capacity and grading.
- Routing evidence is only a reviewed verdict: a `--checks` checker's `As found:` line or the
  parent's `crew grade`. A run's own DONE never is. Tests point `router.command` at a fake router.
