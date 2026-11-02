---
id: MEM-0003
title: Agents propose, humans accept
kind: decision
status: accepted
scope:
  - lib/commands/write.js
  - lib/context.js
  - lib/records.js
evidence:
  - kind: contains
    path: lib/commands/write.js
    pattern: only a human can
  - kind: contains
    path: lib/records.js
    pattern: agent-sourced record is accepted without 'reviewed'
  - kind: command
    run: node --test test/write.test.js
recorded: 2026-11-02
source:
  by: agent
reviewed:
  by: Semeton Balogun
  on: 2026-11-02
---

# Agents propose, humans accept

## Rule

`propose` always writes status `proposed` and assigns the id, date and source itself. `accept` and `reject` refuse to run when an agent-session variable is set. Lint fails an agent-sourced record that is accepted without a `reviewed` entry, so hand-editing the status does not get around the gate.

## Why

An agent's guess must not harden into a team rule without a person looking at it. The environment check is a visible speed bump, not a lock (an agent can unset a variable). The lock is review: CODEOWNERS on the records folder plus `check --since`, which reports records a PR weakened.
