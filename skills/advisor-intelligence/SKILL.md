---
name: advisor-intelligence
description: Choose or pin a model for a crew run from the user's roster, without changing global settings.
---

# Model choice

`crew spawn` picks the model itself. The router judges the task against the user's roster
(`crew roster` shows each model's roles, cost, what it is for and not for, and its track
record); without a router, a spawn takes the roster's first model for the role, then the role
defaults in `~/.config/crew/config.json`. `crew route --role R --task T` shows the pick
without launching anything.

Leave the choice to the router unless the user named a model or the pick is plainly wrong for
the task. Then pin one from the roster, `crew spawn --model <host>/<model>@<effort>`, and say
why in one line. A model outside the roster needs the user's say-so. If the user wants
routing off for this session, run `crew router off` (children inherit it; `crew router reset`
undoes it). With no roster yet, the user can build one with the `roster` skill.

For a native read-only lookup, pick the cheapest model the host offers that can do it
(Claude Code: `model: "haiku"` or `"sonnet"`), never your own model by default.

A skill cannot change your running root model. Do not modify global settings, authentication
or permissions to follow this guide.
