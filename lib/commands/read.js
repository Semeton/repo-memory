"use strict";

// Read-only commands: what an agent (or a person) runs to see the memory.
//   for <path>...   records that apply to these files: the retrieval step
//   show <id>...    the record files themselves
//   list            every record, one line each

const fs = require("fs");
const { loadRecords, LIVE } = require("../records");
const { health } = require("../health");
const { matches, normalize } = require("../glob");
const { renderForAgent, table } = require("../render");
const { UsageError } = require("../errors");

function forPaths({ ctx, args, flags, out }) {
  if (!args.length) throw new UsageError("usage: repo-memory for <path>...");
  const { repo, config } = ctx;
  const { records } = loadRecords(repo, config);
  const live = records.filter((r) => LIVE.includes(r.status));
  const results = args.map((p) => {
    const rel = normalize(p);
    const hits = live.filter((r) => r.scope.some((g) => typeof g === "string" && matches(g, rel)));
    return { path: rel, records: hits.map((r) => ({ record: r, health: health(r, repo, config) })) };
  });

  if (flags.json) {
    out(JSON.stringify({
      version: 1,
      paths: results.map((x) => ({
        path: x.path,
        records: x.records.map(({ record: r, health: h }) => ({
          id: r.id, file: r.file, status: r.status, kind: r.kind, title: r.title,
          rule: r.rule, why: r.why, revisit_when: r.revisitWhen || undefined,
          flags: h.flags.filter((f) => f.type !== "SKIPPED"),
        })),
      })),
    }, null, 2));
    return 0;
  }

  // Several paths often share records; print each record once, listing its paths.
  const seen = new Map();
  for (const x of results) {
    for (const { record, health: h } of x.records) {
      if (!seen.has(record.id)) seen.set(record.id, { record, health: h, paths: [] });
      seen.get(record.id).paths.push(x.path);
    }
  }
  const none = results.filter((x) => !x.records.length).map((x) => x.path);
  if (!seen.size) {
    out(`No recorded decisions apply to ${none.join(", ")}.`);
    return 0;
  }
  out(`# Recorded decisions for ${args.length === 1 ? results[0].path : `${args.length} paths`}\n`);
  for (const { record, health: h, paths } of seen.values()) {
    if (args.length > 1) out(`Applies to: ${paths.map((p) => `\`${p}\``).join(", ")}\n`);
    out(renderForAgent(record, h));
  }
  if (none.length && args.length > 1) out(`No recorded decisions apply to: ${none.join(", ")}`);
  return 0;
}

function show({ ctx, args, out, err }) {
  if (!args.length) throw new UsageError("usage: repo-memory show <id>...");
  const { repo, config } = ctx;
  const { records } = loadRecords(repo, config);
  let missing = 0;
  args.forEach((id, i) => {
    const r = records.find((x) => x.id === id);
    if (!r) {
      err(`${id}: not found in ${config.dir}/`);
      missing++;
      return;
    }
    if (i > 0) out("");
    out(`<!-- ${r.file} -->`);
    out(fs.readFileSync(repo.abs(r.file), "utf8").trimEnd());
  });
  return missing ? 1 : 0;
}

function list({ ctx, flags, out }) {
  const { repo, config } = ctx;
  const { records } = loadRecords(repo, config);
  const wanted = flags.status ? String(flags.status).split(",") : null;
  const rows = records.filter((r) => !wanted || wanted.includes(r.status));
  if (flags.json) {
    out(JSON.stringify({
      version: 1,
      records: rows.map((r) => ({ id: r.id, file: r.file, status: r.status, kind: r.kind, title: r.title, scope: r.scope })),
    }, null, 2));
    return 0;
  }
  if (!rows.length) {
    out(wanted ? `No ${wanted.join("/")} records.` : `No records in ${config.dir}/ yet.`);
    return 0;
  }
  out(table(rows.map((r) => [r.id, r.status, r.kind, r.title]), ["Id", "Status", "Kind", "Title"]));
  return 0;
}

module.exports = { forPaths, show, list };
