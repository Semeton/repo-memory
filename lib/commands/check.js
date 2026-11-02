"use strict";

// repo-memory check: the CI gate. Lints every record, then checks the evidence of
// every accepted record against the code as it is now. Exit 1 on any lint error,
// STALE or VIOLATED record (and REVIEW DUE with --strict).

const { loadRecords, lint, LIVE } = require("../records");
const { health, isFailing } = require("../health");
const { matches } = require("../glob");
const { UsageError } = require("../errors");
const { recordChanges } = require("../changes");

function touches(record, changed) {
  if (changed.includes(record.file)) return true;
  const globs = [...record.scope];
  for (const e of record.evidence) if (e && typeof e.path === "string") globs.push(e.path);
  if (globs.some((g) => typeof g === "string" && changed.some((f) => matches(g, f)))) return true;
  // class evidence: resolved through PSR-4, so match on the file name.
  return record.evidence.some(
    (e) => e && e.kind === "class" && typeof e.name === "string" && changed.some((f) => f.endsWith(`/${e.name.split("\\").pop()}.php`)),
  );
}

function check({ ctx, flags, out }) {
  const { repo, config } = ctx;
  const { records, skipped, issues: loadIssues } = loadRecords(repo, config);
  const issues = [...loadIssues, ...lint(records, config)];
  for (const k of config.unknownKeys || []) issues.push({ level: "warning", file: config.file, message: `unknown config key '${k}'` });

  let selected = records.filter((r) => LIVE.includes(r.status));
  let since = null;
  let renames;
  let changes = [];
  if (flags.since) {
    if (!repo.isGit()) throw new UsageError("--since needs a git repository");
    if (!repo.resolveRef(flags.since)) throw new UsageError(`--since: '${flags.since}' does not resolve to a commit (in CI, fetch history: actions/checkout with fetch-depth: 0)`);
    const d = repo.diff(flags.since);
    renames = d.renames;
    since = { ref: flags.since, merge_base: repo.mergeBase(flags.since), changed: d.changed.length };
    selected = selected.filter((r) => touches(r, d.changed));
    changes = recordChanges(repo, config, flags.since, d, records);
  }

  const results = selected.map((r) => ({ record: r, ...health(r, repo, config, { run: !!flags.run, renames }) }));
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const count = (t) => results.filter((x) => x.flags.some((f) => f.type === t)).length;
  const summary = {
    records: records.length,
    checked: results.length,
    ok: results.filter((x) => !x.flags.some((f) => isFailing(f, true) || f.type === "UNANCHORED")).length,
    stale: count("STALE"),
    violated: count("VIOLATED"),
    unknown: count("UNKNOWN"),
    review_due: count("REVIEW DUE"),
    weakened: changes.filter((c) => c.type === "WEAKENED").length,
    unanchored: count("UNANCHORED"),
    commands_skipped: results.reduce((n, x) => n + x.flags.filter((f) => f.type === "SKIPPED").length, 0),
    proposed: records.filter((r) => r.status === "proposed").length,
    lint_errors: errors.length,
    lint_warnings: warnings.length,
    skipped_files: skipped.length,
  };
  // Weakened records don't fail by default: retiring a rule is legitimate, and the
  // gate for it is a human reviewing the records folder. --strict makes it blocking.
  const failed =
    errors.length > 0 ||
    results.some((x) => x.flags.some((f) => isFailing(f, !!flags.strict))) ||
    (!!flags.strict && summary.weakened > 0);

  if (flags.json) {
    out(JSON.stringify({
      version: 1,
      ok: !failed,
      dir: config.dir,
      since,
      summary,
      lint: issues,
      records: results.map((x) => ({
        id: x.record.id,
        file: x.record.file,
        status: x.record.status,
        title: x.record.title,
        flags: x.flags,
        evidence: x.evidence.map((e) => ({ kind: e.evidence.kind, label: e.label, status: e.status, message: e.message, locations: e.locations })),
      })),
      proposed: records.filter((r) => r.status === "proposed").map((r) => ({ id: r.id, file: r.file, title: r.title })),
      record_changes: changes,
    }, null, 2));
    return failed ? 1 : 0;
  }

  const pad = (s) => s.padEnd(11);
  const statusCounts = {};
  for (const r of records) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  const breakdown = Object.entries(statusCounts).map(([s, n]) => `${n} ${s}`).join(", ");
  out(`repo-memory check  ${config.dir}/  ${records.length} record${records.length === 1 ? "" : "s"}${breakdown ? ` (${breakdown})` : ""}`);
  if (since) out(`  limited to records touched by ${since.ref}...HEAD (${since.changed} file${since.changed === 1 ? "" : "s"} changed)`);
  if (!records.length && !issues.length) {
    out(`  no records yet${skipped.length ? ` (${skipped.length} Markdown file${skipped.length === 1 ? "" : "s"} without an id ignored)` : ""}`);
  }

  for (const i of issues) out(`${pad(i.level === "error" ? "ERROR" : "WARN")}${i.file}${i.line ? `:${i.line}` : ""}  ${i.id ? i.id + ": " : ""}${i.message}`);
  for (const x of results) {
    const shown = x.flags.filter((f) => flags.verbose || f.type !== "SKIPPED");
    if (!shown.length) {
      out(`${pad("OK")}${x.record.id}  ${x.record.title}`);
      continue;
    }
    for (const f of shown) {
      out(`${pad(f.type)}${x.record.id}  ${f.message}`);
      if (flags.verbose && f.output) out(f.output.split("\n").map((l) => `             ${l}`).join("\n"));
    }
  }
  for (const r of records.filter((r) => r.status === "proposed")) out(`${pad("PROPOSED")}${r.id}  ${r.title} (awaiting human review)`);

  if (changes.length) {
    out(`\nRecords changed in this diff (a human should review these, not just the code):`);
    for (const c of changes) {
      out(`${pad(c.type)}${c.id}  ${c.file}`);
      for (const d of c.details) out(`             ${d}`);
    }
  }

  const parts = [`${summary.ok} ok`];
  if (summary.stale) parts.push(`${summary.stale} stale`);
  if (summary.violated) parts.push(`${summary.violated} violated`);
  if (summary.unknown) parts.push(`${summary.unknown} unknown`);
  if (summary.weakened) parts.push(`${summary.weakened} weakened by this change${flags.strict ? "" : " (fails with --strict)"}`);
  if (summary.review_due) parts.push(`${summary.review_due} review due`);
  if (summary.unanchored) parts.push(`${summary.unanchored} unanchored`);
  if (errors.length) parts.push(`${errors.length} lint error${errors.length === 1 ? "" : "s"}`);
  if (warnings.length) parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
  if (summary.commands_skipped) parts.push(`${summary.commands_skipped} command${summary.commands_skipped === 1 ? "" : "s"} not run (--run)`);
  out(`\n${failed ? "FAIL" : "PASS"}  ${parts.join(", ")}`);
  return failed ? 1 : 0;
}

module.exports = { check, touches };
