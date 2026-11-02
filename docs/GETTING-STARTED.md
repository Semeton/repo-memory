# Getting started

Add repo-memory to an existing codebase in about ten minutes. You need Node 18 or newer. Your project can be in any language.

## 1. Set it up

From the root of your repository:

```bash
npx @semeton/repo-memory init --ci github
```

This creates three files and changes nothing else:

- `repo-memory.json`: settings (you can leave the defaults)
- `docs/decisions/README.md`: where your records will live
- `.github/workflows/repo-memory.yml`: runs the check on every pull request

If you don't use GitHub Actions, leave out `--ci github` and add `npx @semeton/repo-memory check` to your CI yourself.

## 2. Write your first record

Pick one thing the code can't explain on its own: a rule that came from an incident, a customer constraint, or an approach the team tried and dropped. Save it as `draft.md` anywhere:

```markdown
---
title: Orders are never hard-deleted
kind: constraint
scope:
  - app/Models/Order.php
  - app/Console/**
evidence:
  - kind: contains
    path: app/Models/Order.php
    pattern: SoftDeletes
---

## Rule

Never hard-delete an order. Soft-delete it so its number stays taken.

## Why

Finance matches bank payments by order number. In March a deleted order's number
was reused, and a customer's payment went to the wrong order.
```

- **scope** lists the files this rule is about. An agent touching those files will be shown the rule.
- **evidence** says how the tool can tell the rule is still true. Here, it checks that `Order.php` still contains `SoftDeletes`. If someone removes it, CI fails.

Then add the record and accept it:

```bash
npx @semeton/repo-memory propose --file draft.md
npx @semeton/repo-memory accept MEM-0001
```

`propose` refuses a record whose evidence doesn't hold today, so a typo in a path shows up straight away. `accept` is for humans: it won't run inside an AI agent's session.

## 3. Check it

```bash
npx @semeton/repo-memory check
```

You should see `OK MEM-0001` and `PASS`. Try breaking it: remove `SoftDeletes` from the file and run `check` again. It fails with `STALE`. Put it back.

## 4. Tell your agent about it

Generate the files your coding agent already reads:

```bash
npx @semeton/repo-memory export claude    # Claude Code
npx @semeton/repo-memory export cursor    # Cursor
npx @semeton/repo-memory export agents    # AGENTS.md, for Codex, Copilot and others
```

Each record now reaches the agent only when it works on matching files. Re-run `export` whenever records change, or use `export all` to do all three at once.

## 5. Protect the records

Records are rules for everyone, so a change to one should be reviewed like a change to code. Add this line to `.github/CODEOWNERS`, using your own team or username:

```text
/docs/decisions/ @your-team
```

Then turn on "Require review from Code Owners" for your main branch.

## 6. Commit

```bash
git add repo-memory.json docs/decisions .github .claude .cursor AGENTS.md
git commit -m "Add repo-memory"
```

Open a pull request. The workflow runs `check` on it.

## Day to day

- **Before changing files**, you or your agent can run `npx @semeton/repo-memory for path/to/file.php` to see the rules that apply.
- **When an agent learns something worth keeping**, it runs `propose`. You read the proposal in the PR and run `accept` or `reject`.
- **When a rule changes**, propose a new record with `supersedes: [MEM-0001]`. Accepting it retires the old one.
- **When CI says STALE**, the code moved: update the record's evidence, or the code, whichever is wrong.

## Already have a decision log?

If you kept decisions in a JSONL file, as in the PHP Talks demo, convert it:

```bash
npx @semeton/repo-memory import .agent/memory/decisions.jsonl
```

Everything else is in the [README](../README.md).
