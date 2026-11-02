# Decision records

This folder holds the team's decision records, managed with [repo-memory](https://github.com/Semeton/repo-memory).
Each record is one Markdown file: frontmatter the tool checks, then `## Rule` and `## Why`.

```markdown
---
id: MEM-0001
title: Order numbers are never reused
kind: constraint            # decision | constraint | convention | finding | rejected
status: accepted            # proposed | accepted | rejected | superseded | deprecated
scope:                      # files this applies to; used to retrieve it
  - app/Modules/Orders/**
evidence:                   # what makes it true in the code today; checked in CI
  - kind: contains
    path: app/Modules/Orders/Models/Order.php
    pattern: SoftDeletes
recorded: 2026-03-14
source:
  by: human                 # human | agent
  ref: incident review, March 2026
---

# Order numbers are never reused

## Rule

Never hard-delete orders. Cancelled orders are soft-deleted so their numbers stay taken.

## Why

In March a purge freed order numbers, a new order reused one, and a customer's payment
was matched to the wrong order.
```

Commands:

- `repo-memory for <path>` shows the records that apply to a file.
- `repo-memory propose --file draft.md` adds a proposal. Agents can propose; only a human can `accept` or `reject`.
- `repo-memory check` fails when a record's evidence no longer holds. It runs in CI.

Markdown files here without an `id` in their frontmatter (like this README, or a plain ADR) are ignored.
