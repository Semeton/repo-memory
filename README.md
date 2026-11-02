# repo-memory

Decision records for codebases that coding agents work in. They live in git, are checked against the code in CI, and become rules only after a human accepts them.

```bash
npx @semeton/repo-memory init --ci github
```

New here? Follow the [ten-minute getting-started guide](docs/GETTING-STARTED.md).

Zero runtime dependencies. Node 18+. Works with any agent (Claude Code, Codex, Cursor, Copilot) and any language; PHP class resolution is built in.

## The problem it solves

A coding agent can read *what* the code does. It can't read *why*: the incident that made a rule, the customer constraint behind a design, the approach the team tried and threw away. So it rediscovers those reasons the hard way, or quietly breaks them.

Writing the reasons down isn't enough on its own. A note that the code has moved on from is worse than no note, because the agent trusts it. And an agent that can write its own memory can turn one bad guess into a team rule.

repo-memory handles both:

- **Every record carries evidence that can fail.** `check` runs in CI with no model involved. When the code a record points at disappears, the record is **STALE**. When the code breaks the rule, it is **VIOLATED**. When the tool can't tell, it is **UNKNOWN**, and UNKNOWN fails too, because "couldn't check" must never look like "checked".
- **Agents propose, humans accept.** `propose` always writes a proposal. `accept` refuses to run inside an agent session. Lint rejects an agent-written record marked accepted without a recorded reviewer.
- **The right record reaches the agent at the right moment.** `for <path>` and the exporters deliver only the records whose scope matches the files being changed, not one big file loaded into every session.

It grew out of the talk *Engineering Memory for AI Coding Agents in PHP Applications* (PHP Talks Lagos, Oct 2026). In that experiment, agents with no memory followed every rule visible in the code but broke the one rule that wasn't. Agents given a record of it did not.

## A record

One Markdown file per record, in `docs/decisions/`:

```markdown
---
id: MEM-0013
title: Order numbers are never reused
kind: constraint            # decision | constraint | convention | finding | rejected
status: accepted            # proposed | accepted | rejected | superseded | deprecated
scope:                      # files it applies to; this is how it is retrieved
  - app/Modules/Orders/**
  - app/Console/**
evidence:                   # what makes it true in the code today; checked in CI
  - kind: contains
    path: app/Modules/Orders/Models/Order.php
    pattern: SoftDeletes
  - kind: absent
    path: "app/**/*.php"
    pattern: Order::query\(\).*->forceDelete\(
  - kind: command
    run: vendor/bin/pest tests/Feature/OrderPurgeTest.php
recorded: 2026-03-14
source:
  by: human                 # human | agent
  ref: incident review, March 2026
review_by: 2027-03-14       # optional: forces a re-read
---

# Order numbers are never reused

## Rule

Never hard-delete an order. Soft-delete or archive it so its number stays taken.

## Why

Finance reconciles bank payments by order number. In March a purged order's number
was issued again, and a customer's payment was matched to a stranger's order.

## Revisit when

Payments are reconciled by a provider reference instead of the order number.
```

Plain ADRs and READMEs in the same folder are ignored: a Markdown file is a record only if its frontmatter has an `id`.

### Evidence kinds

| Kind | Fields | Holds when | Fails as |
| --- | --- | --- | --- |
| `path` | `path` (glob) | something matches | STALE |
| `contains` | `path`, `pattern` (regex), `flags`? | some matching file contains the pattern | STALE |
| `absent` | `path`, `pattern`, `flags`? | no matching file contains the pattern | VIOLATED |
| `class` | `name` (PHP FQCN) | composer's PSR-4 map resolves it to a file that declares it | STALE |
| `command` | `run`, `timeout`? | the command exits 0. Runs only with `check --run` | VIOLATED |

Globs are relative to the repository root and follow the usual rules (`*`, `**`, `?`, `{a,b}`). They match tracked and untracked files, but not git-ignored ones, so evidence points at source, not `vendor/`. Patterns are JavaScript regular expressions, matched line by line and then against the whole file.

A file that can't be searched (binary, or over 2 MB) makes `contains` and `absent` report UNKNOWN rather than claim a match or an absence.

## Commands

```text
repo-memory for <path>...           records that apply to these files
repo-memory show <id>...            print record files
repo-memory list [--status s,...]

repo-memory check                   lint everything; check accepted records' evidence
  --run                             also execute `command` evidence
  --since <ref>                     only records this change touches, plus records it weakened
  --strict                          also fail on REVIEW DUE and on weakened records
  --verbose                         show skipped commands and failing command output

repo-memory propose --file <draft.md|draft.json>   (or pipe it on stdin)
repo-memory accept <id>             human only
repo-memory reject <id>             human only; the record stays as "don't propose this again"

repo-memory export <claude|cursor|agents|all> [--check]
repo-memory init [--dir <d>] [--ci github]
repo-memory import <decisions.jsonl> [--test-command '<cmd with {file} and {filter}>']
```

`--json` works with `check`, `for` and `list`. Exit codes: `0` pass, `1` the records or the code failed, `2` usage or configuration error. Both the exit codes and the JSON shape (which carries `version: 1`) are a stable contract.

## The write path

```text
agent or human ──propose──▶ proposed ──accept (a human, in a PR)──▶ accepted ──▶ superseded / deprecated
                                │
                                └──reject──▶ rejected (kept, so the idea isn't proposed again)
```

- **`propose` refuses a record that isn't true today.** Its evidence must hold against the current code. A record that is stale the day it's written teaches nothing.
- **The tool, not the author, sets `id`, `status`, `recorded` and, inside an agent session, `source.by: agent`.**
- **`accept` re-checks the evidence** and retires anything the record supersedes, so both ends of the chain agree.
- **The agent-session check is a speed bump, not a lock.** `accept` refuses when `CLAUDECODE`, `AI_AGENT`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI` or `OPENCODE` is set, but an agent can unset a variable. The lock is code review: put the records folder under CODEOWNERS and require code-owner review.

## In CI

`init --ci github` writes this workflow:

```yaml
env:
  REPO_MEMORY: "@semeton/repo-memory@0.1.0"   # exact version: bump it deliberately, in its own PR
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - run: npx --yes "$REPO_MEMORY" check --since "origin/$GITHUB_BASE_REF"
```

**Why the version is pinned.** The tool deciding whether a PR passes should not be code that PR can change. Run a pinned published version, never a copy from the checkout under review.

**What `--since` adds.** It reports records that the pull request *itself* weakened: evidence or scope removed, an accepted record deleted or demoted, or a record added already accepted. That closes a real hole. A PR could add a `forceDelete()` and, in the same diff, delete the `absent` evidence that would have caught it. Every record would still check out green. `--since` lists that change as WEAKENED, so the reviewer sees it, and `--strict` blocks the merge on it.

**Command evidence.** `command` evidence (a test that enforces a rule) needs your app's runtime. Run `check --run` in the job that already has PHP, a database and so on.

## Delivering records to agents

`export` writes generated files that agents already know how to load. They are always generated from the records and never edited by hand. `export --check` in CI fails when they drift from the records.

- `claude`: `.claude/rules/repo-memory/<id>.md`, path-scoped rules that Claude Code loads only for matching files
- `cursor`: `.cursor/rules/repo-memory/<id>.mdc`, using `globs`
- `agents`: a short index in `AGENTS.md`, between markers. It lists the records and tells the agent to run `repo-memory for <path>` before changing files. It deliberately does not paste the records in: research on repository context files found that more always-loaded context can make agents worse and more expensive.

A record with broken evidence is still exported, but with a warning telling the agent to verify it and tell the developer. Hiding it would be worse.

## What it does not do

- **It does not prove the code is correct.** `contains` proves a pattern is present, not that the rule around it is followed. Where a rule can be executed, make it a test and point `command` evidence at it: the test enforces the *what*, and the record keeps the *why*.
- **It can't catch a rule that quietly became wrong** while its evidence still holds. `review_by` dates exist for that, and they need a human.
- **Retrieval is path globs.** That is enough for dozens of records, and possibly a few hundred. Beyond that, or when relevance can't be expressed as a path, you need a real index.
- **The agent-session check can be bypassed.** Review is the gate (see above).

## Configuration

`repo-memory.json` at the repository root. Every key is optional.

```json
{
  "version": 1,
  "dir": "docs/decisions",
  "idPrefix": "MEM",
  "idWidth": 4,
  "agentEnv": ["CLAUDECODE", "AI_AGENT", "CURSOR_AGENT", "CODEX_SANDBOX", "GEMINI_CLI", "OPENCODE"],
  "commandTimeout": 300
}
```

## Migrating from a JSONL log

```bash
repo-memory import .agent/memory/decisions.jsonl --test-command 'php vendor/bin/pest {file} --filter="{filter}"'
```

`test` evidence becomes a `path` entry plus a `command` entry. An agent-written record marked accepted with no recorded reviewer comes in as **proposed**: import won't invent a review.

## Programmatic use

```js
const { recordsFor, createContext, loadRecords, health } = require("@semeton/repo-memory");
recordsFor(process.cwd(), "app/Modules/Orders/Order.php"); // [{ record, health }]
```

## License

MIT
