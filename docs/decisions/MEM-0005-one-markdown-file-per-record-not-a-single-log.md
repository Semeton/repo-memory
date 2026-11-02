---
id: MEM-0005
title: One Markdown file per record, not a single log
kind: rejected
status: proposed
scope:
  - lib/records.js
  - docs/decisions/**
evidence: []
recorded: 2026-11-02
source:
  by: agent
---

# One Markdown file per record, not a single log

## Rule

Do not go back to one append-only JSONL file for all records.

## Why

The PHP Talks demo used `.agent/memory/decisions.jsonl`. Every pull request that adds a record appends to the same file, so parallel agent PRs conflict on every merge, and a reviewer reads a JSON line instead of prose. One file per record merges cleanly, diffs readably and works with CODEOWNERS per folder. `repo-memory import` converts old logs.
