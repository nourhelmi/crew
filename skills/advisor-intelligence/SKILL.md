---
name: advisor-intelligence
description: Apply the intelligence profiles when pinning a model for a crew run or a native subagent, without changing global settings.
---

# Intelligence routing

`crew spawn` routes on its own. Unless you pass `--model`, it asks the Jev router
(`agent-router`, fed from these profiles) for the best native candidate for the role and
task, and falls back to the role default in `~/.config/crew/config.json`. `crew route --role R --task T`
shows the decision without launching anything. Read a profile only when you are pinning a
model yourself or choosing one for a native subagent.

Profiles are advisory judgment/cost guidance, not model availability or tool permissions. Read only the selected profile, and only when a model-routing decision is relevant.

Selection order: the user's explicit choice (read this skill's `profiles/<name>.json`); otherwise the existing `~/.pi/agent/advisor-intelligence.json` if present (read-only); otherwise the bundled `profiles/balanced.json`. Available names are the JSON filenames there. Never load every preset at startup or after compaction. Use these installed paths, not a home-directory search through past runs, backups or packed verification archives.

Use the profile's role recommendations and task-fit descriptions. Sol and Luna refer to GPT-6; Opus refers to Claude Opus 5.5 at medium or high. The current Codex Lean guide uses Sol high for root and child advisors, including planning and synthesis; Sol xhigh owns regular implementation/checking, while Sol max owns materially ambiguous or wide work. Luna max is an optional economical choice for explicitly assigned browser-heavy work, not a required handoff. Former Sonnet recommendations use Opus medium. Browser verification belongs to the author of affected behavior. The selected JSON is authoritative if these recommendations evolve.

Model ids map to CLIs by provider: `anthropic/` and `claude-bridge/` models (or bare `claude-*`, `opus`) run in Claude Code, and `openai/` and `openai-codex/` models (or bare `gpt-*`) run in Codex. `crew spawn --model` accepts either form plus `@effort`, and clamps efforts a CLI lacks (Codex has no `max`; it becomes `xhigh`). Other providers have no native CLI and are refused. For a native subagent, use only the model and effort controls the host actually exposes and disclose material differences.

A skill cannot change your running root model. Do not modify global settings, authentication or permissions to follow this guide. A user may choose a profile for this workstream without globally switching anything. Native delegation may expose fewer model/effort controls; preserve the role's reasoning and evidence requirements even when model choice is unavailable.
