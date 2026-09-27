---
name: roster
description: Set up or tune the models crew routes work to - which subscriptions you have, what each model is for, and what it costs you. Use when the user wants to configure, review or change their crew roster or model choices.
---

# Crew roster

The roster (`crew roster` shows it; the file is `~/.config/crew/roster.json`) lists every model
crew may launch, per role, in preference order. The router reads it to pick a model for each
spawn; without a router, spawns take the first model per role.

## 1. Look before asking

- `crew roster`: the current roster, each model's track record, and anything crew can't launch.
- Which host CLIs exist: `command -v claude codex opencode`. `opencode models` lists what the
  user's OpenCode providers offer.
- Recent work: `crew ls --all` shows which models ran as what.

## 2. Ask, briefly

In one message: which subscriptions and plan sizes they have, which models they've used and
what they think of them, and what kind of work they mostly hand off. Their opinions outrank
anything below.

## 3. Draft each entry

```json
{ "model": "codex/gpt-6-sol", "effort": "high", "roles": ["advisor", "builder"], "cost": 0.15,
  "about": "the workhorse", "use": "…", "avoid": "…" }
```

- **model**: `<host>/<model id>` (`claude/claude-opus-5-5`, `codex/gpt-6-sol`,
  `opencode/opencode-go/kimi-k3`). **effort**: one the model supports.
- **roles**: `advisor`, `builder`, `checker`. Give a model only the roles it is good at.
- **cost** from 0 to 1: the share of the user's limits one assignment burns. A bigger plan makes
  a model cheaper and a hungrier model or higher effort makes it dearer. Set the dearest at 1
  and scale the rest against it.
- **use / avoid**: the router's model judges fit from these alone. Name concrete kinds of work,
  and always say what a model is *worse* at. If every entry sounds good at everything, the
  router scores them all alike and quota headroom decides instead.
- **scope**: `"small-or-verification"` for a cheap model that fumbles interpretation. It is
  then admitted only for small tasks or pure verification.
- A model the user hasn't tried: draft from public evidence (`agent-router benchmarks list`,
  the provider's docs), say so in `about`, and let the track record correct it.
- Order the file by preference within each role; ties go to the earlier entry.

## 4. Write, wire, try

1. Write the file, then run `crew roster` and fix whatever it flags.
2. If the router is installed and not reading this file, run
   `agent-router roster use --file ~/.config/crew/roster.json` (or `agent-router init --roster
   ~/.config/crew/roster.json` when it has no config yet).
3. Take 5–10 real tasks from the user's work across all three roles. Run
   `crew route --role <role> --task "<task>"` for each and show the picks side by side. Adjust
   `use`/`avoid` until the picks match what the user would choose. Don't tune to a single task.

From then on the roster learns: checkers spawned with `--checks <run>` and `crew grade` build
each model's track record, which `crew roster` shows.
