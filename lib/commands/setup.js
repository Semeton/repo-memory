"use strict";

// Getting a repository onto repo-memory.
//   init                 config file, record directory, optional CI workflow
//   import <log.jsonl>   convert a JSONL decision log (the PHP Talks demo format)

const fs = require("fs");
const path = require("path");
const { CONFIG_FILE, CONFIG_VERSION, DEFAULTS } = require("../config");
const { loadRecords, renderRecordFile, recordPath, isDate, STATUSES, KINDS } = require("../records");
const { today } = require("../health");

// A short title from a free-form decision: its first clause, cut at a word boundary.
function titleFrom(text) {
  // Abbreviations like "e.g." and "i.e." end with a dot but don't end the clause.
  const masked = String(text).trim().replace(/\b(e\.g|i\.e|etc|vs|approx)\./gi, (m) => m.replace(/\./g, "\u0000"));
  const first = masked.split(/(?<=[.;:])\s|\s[-\u2013\u2014]\s/)[0].replace(/\u0000/g, ".").replace(/[.;:,\s]+$/, "");
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  return cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80).replace(/[,;:\s]+$/, "") + "…";
}
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
  if (!src) throw new UsageError("usage: repo-memory import <decisions.jsonl> (repo-memory demo format, or agent-contract's pre-0.10 log) [--test-command '<cmd with {file} and {filter}>'] [--dry-run]");
  const file = path.resolve(src);
  if (!fs.existsSync(file)) throw new UsageError(`${src} does not exist`);
  const { repo, config } = ctx;
  const current = loadRecords(repo, config).records;
  const existing = new Set(current.map((r) => r.id));
  // Lines an existing record already cites as its source ("decisions.jsonl line 9",
  // "decisions.jsonl, line 9") were converted before, by hand or by an earlier import.
  const logName = path.basename(file);
  const citedLines = new Map();
  for (const r of current) {
    const ref = r.data.source && typeof r.data.source.ref === "string" ? r.data.source.ref : "";
    const m = new RegExp(`${logName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},?\\s+line\\s+(\\d+)`).exec(ref);
    if (m) citedLines.set(Number(m[1]), r.id);
  }
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const planned = [];
  const demoted = [];
  const fromLog = [];
  const counts = { runs: 0, unrecognised: 0, duplicates: 0 };
  const seenDecisions = new Set();
  // Ids for free-form entries continue after the highest existing MEM-style id.
  const prefix = `${config.idPrefix}-`;
  let nextNum = Math.max(0, ...[...existing].filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)) || 0));

  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      throw new UsageError(`${src}:${i + 1}: not valid JSON (${e.message})`);
    }
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      counts.unrecognised++;
      warn(`line ${i + 1}: not a JSON object, skipped`);
      return;
    }

    // agent-contract's log (before 0.10): free-form entries an agent wrote when told to
    // "log non-trivial decisions", mixed with run telemetry. Decisions become proposals;
    // run entries are skipped.
    if (!r.id && typeof r.decision === "string" && r.decision.trim()) {
      if (citedLines.has(i + 1)) {
        counts.converted = (counts.converted || 0) + 1;
        return;
      }
      const key = r.decision.trim().toLowerCase();
      if (seenDecisions.has(key)) {
        counts.duplicates++;
        return;
      }
      seenDecisions.add(key);
      nextNum++;
      const id = `${prefix}${String(nextNum).padStart(config.idWidth, "0")}`;
      const title = titleFrom(r.decision);
      const ts = typeof r.ts === "string" ? r.ts.slice(0, 10) : "";
      const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !["ts", "decision", "why", "alternatives"].includes(k)));
      const data = {
        id,
        title,
        kind: "decision",
        status: "proposed",
        scope: [],
        evidence: [],
        recorded: isDate(ts) ? ts : today(),
        source: { by: "agent", ref: `agent-contract decisions.jsonl, line ${i + 1}${r.ts ? `, ${r.ts}` : ""}` },
      };
      const sections = {
        rule: r.decision.trim(),
        why: (typeof r.why === "string" && r.why.trim()) || "Not recorded in the original log. Add the reason before accepting.",
      };
      const alt = Array.isArray(r.alternatives) ? r.alternatives.map((a) => `- ${a}`).join("\n") : r.alternatives;
      if (typeof alt === "string" && alt.trim()) sections.alternatives_considered = alt.trim();
      if (Object.keys(extra).length) sections.original_log_fields = "```json\n" + JSON.stringify(extra, null, 2) + "\n```";
      fromLog.push(id);
      planned.push({ rel: recordPath(config, id, title), content: renderRecordFile(data, sections) });
      return;
    }
    if (!r.id && typeof r.ts === "string" && "role" in r && "task" in r && ["tokens", "provider", "model", "checks"].some((k) => k in r)) {
      counts.runs++;
      return;
    }
    if (!r.id || !r.title) {
      counts.unrecognised++;
      warn(`line ${i + 1}: neither a record (id, title) nor a decision entry, skipped`);
      return;
    }
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
  if (counts.runs) err(`  note  ${counts.runs} agent-contract run entr${counts.runs === 1 ? "y" : "ies"} skipped (telemetry, not decisions)`);
  if (counts.converted) err(`  note  ${counts.converted} decision${counts.converted === 1 ? "" : "s"} skipped: already converted (an existing record cites the line)`);
  if (counts.duplicates) err(`  note  ${counts.duplicates} duplicate decision${counts.duplicates === 1 ? "" : "s"} skipped`);
  if (fromLog.length) {
    err(`  note  ${fromLog.length} free-form decision${fromLog.length === 1 ? "" : "s"} imported as proposals (${fromLog[0]}${fromLog.length > 1 ? `…${fromLog[fromLog.length - 1]}` : ""}).`);
    err("        Review each in a PR: add scope (the files it applies to) and evidence if you can, then `repo-memory accept <id>` or `reject <id>`.");
  }
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
