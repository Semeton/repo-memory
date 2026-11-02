---
id: MEM-0002
title: Uncertainty never counts as a pass
kind: constraint
status: proposed
scope:
  - lib/evidence.js
  - lib/health.js
  - lib/commands/check.js
evidence:
  - kind: contains
    path: lib/health.js
    pattern: "\\[\"VIOLATED\", \"STALE\", \"UNKNOWN\"\\]\\.includes\\(flag\\.type\\)"
  - kind: command
    run: node --test test/check.test.js
recorded: 2026-11-02
source:
  by: agent
---

# Uncertainty never counts as a pass

## Rule

When evidence cannot be evaluated (no PSR-4 map for a class, a file that could not be searched), report UNKNOWN and fail `check`. Never map "could not establish" to OK, and never claim a pattern is absent from files that were not read.

## Why

A gate that turns missing information into success stops meaning anything, and nobody notices because it stays green. A design review of the PR trust layer (Nov 2026) named this as a core failure mode; it applies to this tool as much as to that one.
