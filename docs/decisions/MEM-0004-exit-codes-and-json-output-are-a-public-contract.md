---
id: MEM-0004
title: Exit codes and --json output are a public contract
kind: convention
status: accepted
scope:
  - lib/cli.js
  - lib/commands/**
evidence:
  - kind: contains
    path: lib/errors.js
    pattern: exit 2
  - kind: contains
    path: lib/commands/check.js
    pattern: "version: 1,"
  - kind: command
    run: node --test test/check.test.js
recorded: 2026-11-02
source:
  by: agent
reviewed:
  by: Semeton Balogun
  on: 2026-11-02
---

# Exit codes and --json output are a public contract

## Rule

Exit 0 means pass, 1 means the records or the code failed, 2 means a usage or configuration error. Every `--json` payload carries `version: 1`. Changing either is a breaking change and needs a major version.

## Why

CI pipelines and other tools (the planned PR trust layer) branch on these. A tool that reports "failed" for a typo in its own flags gets disabled; one whose JSON shape drifts breaks every integration silently.
