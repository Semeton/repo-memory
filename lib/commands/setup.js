"use strict";

// Getting a repository onto repo-memory.
//   init                 config file, record directory, optional CI workflow
//   import <log.jsonl>   convert a JSONL decision log (the PHP Talks demo format)

const fs = require("fs");
const path = require("path");
const { CONFIG_FILE, CONFIG_VERSION, DEFAULTS } = require("../config");
const { loadRecords, renderRecordFile, recordPath, STATUSES, KINDS } = require("../records");
const { UsageError } = require("../errors");

const DIR_README = (dir) => `# Decision records

This folder holds the team's decision records, managed with [repo-memory](https://github.com/Semeton/repo-memory).
Each record is one Markdown file: frontmatter the tool checks, then \`## Rule\` and \`## Why\`.

\`\`\`markdown
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
\`\`\`

Commands:

- \`repo-memory for <path>\` shows the records that apply to a file.
- \`repo-memory propose --file draft.md\` adds a proposal. Agents can propose; only a human can \`accept\` or \`reject\`.
- \`repo-memory check\` fails when a record's evidence no longer holds. It runs in CI.

Markdown files here without an \`id\` in their frontmatter (like this README, or a plain ADR) are ignored.
`;

// The evaluator is pinned to an exact published version and fetched from npm, never
// run from the pull request's own checkout: a PR must not be able to change the code
// that decides whether it passes. Bump the version deliberately, in its own PR.
const WORKFLOW = (version) => `name: repo-memory
on:
  pull_request:
  push:
    branches: [main, master]
permissions:
  contents: read
env:
  REPO_MEMORY: "@semeton/repo-memory@${version}"
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --since needs the merge base
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Every record is linted; every accepted record's evidence is checked against
      # this commit. Fails on STALE, VIOLATED or UNKNOWN evidence.
      - run: npx --yes "$REPO_MEMORY" check
        if: github.event_name != 'pull_request'
      # On a pull request, also report records the PR itself weakened (evidence or
      # scope removed, accepted record deleted). Add --strict to make that blocking.
      - run: npx --yes "$REPO_MEMORY" check --since "origin/$GITHUB_BASE_REF"
        if: github.event_name == 'pull_request'
      # Uncomment if you commit exported agent rules, so they can't drift from the records.
      # - run: npx --yes "$REPO_MEMORY" export all --check
      #
      # \`command\` evidence (a test that enforces a rule) only runs with --run.
      # Run it after your app's test setup, in the job that has PHP, a database, etc:
      #   npx --yes "$REPO_MEMORY" check --run
`;

function writeIfAbsent(repo, rel, content, out) {
  if (repo.exists(rel)) {
    out(`  exists   ${rel}`);
    return false;
  }
  fs.mkdirSync(path.dirname(repo.abs(rel)), { recursive: true });
  fs.writeFileSync(repo.abs(rel), content);
  out(`  created  ${rel}`);
  return true;
}

function init({ ctx, flags, out }) {
  const { repo, config } = ctx;
  const dir = flags.dir ? String(flags.dir).replace(/\\/g, "/").replace(/\/+$/, "") : config.dir;
  out(`repo-memory init  ${repo.root}`);
  const cfg = { version: CONFIG_VERSION, dir, idPrefix: config.idPrefix };
  if (config.file && flags.dir && flags.dir !== config.dir) out(`  note     ${CONFIG_FILE} exists; its dir (${config.dir}) is unchanged`);
  writeIfAbsent(repo, CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", out);
  writeIfAbsent(repo, `${dir}/README.md`, DIR_README(dir), out);
  if (flags.ci === "github" || flags.ci === true) writeIfAbsent(repo, ".github/workflows/repo-memory.yml", WORKFLOW(require("../../package.json").version), out);
  else if (flags.ci) throw new UsageError("--ci: only 'github' is supported");
  // agent-contract (0.10+) reads repo-memory.json and points its shim at repo-memory, but
  // only when its own init/update runs. Until then its shim tells agents to write ADRs.
  const agentContract = repo.exists(".agent/manifest.yaml");
  if (agentContract) {
    out("");
    out(`  agent-contract detected: both tools keep decisions in ${dir}/.`);
    out("  Run `agent-contract update` (0.10 or newer) so its CLAUDE.md/AGENTS.md shim tells agents to propose with repo-memory.");
  }
  out("");
  out("Next:");
  out(`  1. Protect the records: add "/${dir}/ @your-team" to .github/CODEOWNERS and require code-owner review.`);
  out(`  2. Gate CI: run \`repo-memory check\`${flags.ci ? " (the workflow above does)" : " (or re-run init with --ci github)"}.`);
  out("  3. Deliver to agents: `repo-memory export claude` / `cursor` / `agents`.");
  return 0;
}

// --- import ------------------------------------------------------------------

function defaultTestCommand(file) {
  if (file.endsWith(".php")) return 'vendor/bin/pest {file} --filter="{filter}"';
  return null;
}

function convertEvidence(e, testCommand, warn, id) {
  if (!e || typeof e !== "object") return [];
  switch (e.kind) {
    case "class":
      return [{ kind: "class", name: String(e.ref) }];
    case "path":
      return [{ kind: "path", path: String(e.ref) }];
    case "test": {
      const [file, filter] = String(e.ref).split("::");
      const out = [{ kind: "path", path: file }];
      const tpl = testCommand || defaultTestCommand(file);
      if (tpl) {
        let run = tpl.replace("{file}", file);
        // No filter: drop the whole argument that carries the {filter} placeholder.
        run = filter ? run.replace("{filter}", filter.replace(/"/g, '\\"')) : run.replace(/\s*\S*\{filter\}\S*/, "");
        out.push({ kind: "command", run: run.trim() });
      } else warn(`${id}: test evidence ${e.ref} kept as a path only (pass --test-command to run it)`);
      return out;
    }
    default:
      warn(`${id}: evidence kind '${e.kind}' has no equivalent; dropped`);
      return [];
  }
}

function importCommand({ ctx, args, flags, out, err }) {
  const src = args[0];
  if (!src) throw new UsageError("usage: repo-memory import <decisions.jsonl> [--test-command '<cmd with {file} and {filter}>'] [--dry-run]");
  const file = path.resolve(src);
  if (!fs.existsSync(file)) throw new UsageError(`${src} does not exist`);
  const { repo, config } = ctx;
  const existing = new Set(loadRecords(repo, config).records.map((r) => r.id));
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const planned = [];
  const demoted = [];

  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      throw new UsageError(`${src}:${i + 1}: not valid JSON (${e.message})`);
    }
    if (!r.id || !r.title) throw new UsageError(`${src}:${i + 1}: a record needs at least id and title`);
    if (existing.has(r.id)) {
      warn(`${r.id}: already exists in ${config.dir}/, skipped`);
      return;
    }
    const data = {
      id: r.id,
      title: r.title,
      kind: KINDS.includes(r.kind) ? r.kind : "finding",
      status: STATUSES.includes(r.status) ? r.status : "proposed",
      scope: Array.isArray(r.scope) ? r.scope : [],
      evidence: (Array.isArray(r.evidence) ? r.evidence : []).flatMap((e) => convertEvidence(e, flags["test-command"], warn, r.id)),
      recorded: r.recorded,
      source: r.source && typeof r.source === "object" ? Object.fromEntries(Object.entries(r.source).filter(([, v]) => v !== null && v !== "")) : { by: "human" },
      review_by: r.review_by || undefined,
      supersedes: Array.isArray(r.supersedes) && r.supersedes.length ? r.supersedes : undefined,
      superseded_by: r.superseded_by || undefined,
      reviewed: r.reviewed || undefined,
    };
    if (!KINDS.includes(r.kind)) warn(`${r.id}: kind '${r.kind}' mapped to 'finding'`);
    // An agent-written record is only live after a human review. The old log may not
    // have recorded one; import won't invent it, so the record comes in as a proposal.
    if (data.status === "accepted" && data.source.by === "agent" && !data.reviewed) {
      data.status = "proposed";
      demoted.push(r.id);
    }
    planned.push({ rel: recordPath(config, r.id, r.title), content: renderRecordFile(data, { rule: r.rule || "", why: r.why || "", revisit_when: r.revisit_when || "" }) });
  });

  for (const w of warnings) err(`  note  ${w}`);
  if (demoted.length) {
    err(`  note  ${demoted.join(", ")}: agent-written and accepted, but no human review was recorded.`);
    err(`        Imported as proposed. A human confirms each with \`repo-memory accept <id>\`.`);
  }
  if (flags["dry-run"]) {
    for (const p of planned) out(`\n<!-- ${p.rel} -->\n${p.content}`);
    out(`\n${planned.length} record${planned.length === 1 ? "" : "s"} would be written.`);
    return 0;
  }
  for (const p of planned) {
    fs.mkdirSync(path.dirname(repo.abs(p.rel)), { recursive: true });
    fs.writeFileSync(repo.abs(p.rel), p.content);
    out(`  wrote  ${p.rel}`);
  }
  out(`Imported ${planned.length} record${planned.length === 1 ? "" : "s"}. Run \`repo-memory check\` next.`);
  return 0;
}

module.exports = { init, importCommand, DEFAULTS };
