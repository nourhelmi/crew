---
name: router
description: Switch crew's Jev model routing on or off for this session and the children it spawns, or show it. Use only when the user invokes it or asks to change or check crew routing.
disable-model-invocation: true
allowed-tools: Bash(crew router:*)
---

# Crew router switch

Run `crew router <action>` in the shell, where `<action>` is the user's argument: `on`, `off`,
`reset` (back to the config default) or `status` (the default when none is given). Add
`--global` only if the user asks to change it for every session.

Relay the first line it prints in one sentence and do nothing else. The setting applies to
this session and to every child it spawns from now on; running children keep their model.
