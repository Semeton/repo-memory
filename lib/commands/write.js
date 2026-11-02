"use strict";

// The write path.
//   propose          anyone, including an agent: writes a record with status proposed
//   accept / reject  humans only: the review step that turns a proposal into a rule
//
// A proposal is refused unless it is already true: its evidence must resolve against
// the code now. A record that is stale on the day it is written teaches nothing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("../yaml");
const { loadRecords, lint, nextId, renderRecordFile, updateRecordFile, recordPath, parseSections } = require("../records");
const { evaluate, describe } = require("../evidence");
const { today } = require("../health");
const { agentSession } = require("../context");
const { UsageError } = require("../errors");

const PROPOSAL_FIELDS = ["title", "kind", "scope", "evidence", "source", "review_by", "supersedes", "tags"];

function readInput(flags, stdin) {
  if (flags.file) {
    const file = path.resolve(String(flags.file));
    if (!fs.existsSync(file)) throw new UsageError(`--file: ${flags.file} does not exist`);
    return { text: fs.readFileSync(file, "utf8"), name: file };
  }
  if (stdin !== null && stdin !== undefined && stdin.trim()) return { text: stdin, name: "<stdin>" };
  throw new UsageError("usage: repo-memory propose --file <record.md|record.json>   (or pipe the record on stdin)");
}

// Accept a proposal as JSON or as a Markdown record. Either way the tool, not the
// author, decides id, status and recorded date.
function parseProposal(text, name) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      throw new UsageError(`${name} is not valid JSON: ${e.message}`);
    }
    const data = {};
    for (const k of PROPOSAL_FIELDS) if (obj[k] !== undefined) data[k] = obj[k];
    for (const k of Object.keys(obj)) if (k.startsWith("x-")) data[k] = obj[k];
    return { data, sections: { rule: obj.rule || "", why: obj.why || "", revisit_when: obj.revisit_when || obj.revisitWhen || "" } };
  }
  const fm = yaml.splitFrontmatter(text);
  if (!fm) throw new UsageError(`${name}: expected JSON, or Markdown starting with '---' frontmatter`);
  let parsed;
  try {
    parsed = yaml.parse(fm.yaml, { lineOffset: 1 });
  } catch (e) {
    throw new UsageError(`${name}: frontmatter ${e.message}`);
  }
  const data = {};
  for (const k of Object.keys(parsed)) if (PROPOSAL_FIELDS.includes(k) || k.startsWith("x-")) data[k] = parsed[k];
  const sections = parseSections(fm.body);
  if (!data.title) {
    const h1 = /^#\s+(.+)$/m.exec(fm.body);
    if (h1) data.title = h1[1].trim();
  }
  return { data, sections };
}

function propose({ ctx, flags, out, err, stdin, env }) {
  const { repo, config } = ctx;
  const { text, name } = readInput(flags, stdin);
  const { data, sections } = parseProposal(text, name);
  const { records } = loadRecords(repo, config);

  const agent = agentSession(config, env);
  const id = nextId(records, config);
  const source = data.source && typeof data.source === "object" && !Array.isArray(data.source) ? { ...data.source } : {};
  if (!source.by) source.by = agent ? "agent" : "human";
  if (agent) source.by = "agent"; // an agent session can't present its proposal as human-written
  const record = {
    id,
    title: typeof data.title === "string" ? data.title.trim() : data.title,
    kind: data.kind || "finding",
    status: "proposed",
    scope: data.scope,
    evidence: data.evidence || [],
    recorded: today(),
    source,
  };
  for (const k of Object.keys(data)) if (!(k in record)) record[k] = data[k];

  const file = recordPath(config, id, record.title || "record");
  const content = renderRecordFile(record, {
    rule: sections.rule || "",
    why: sections.why || "",
    revisit_when: sections.revisit_when || "",
  });

  // Lint the new record together with the existing ones (duplicate ids, supersedes).
  const { parseRecordText } = require("../records");
  const parsed = parseRecordText(content, file);
  if (!parsed.record) throw new UsageError(`proposal could not be rendered: ${(parsed.error && parsed.error.message) || parsed.skipped}`);
  const problems = lint([...records, parsed.record], config).filter((i) => i.file === file && i.level === "error");
  for (const old of [].concat(record.supersedes || [])) {
    const o = records.find((r) => r.id === old);
    if (!o) problems.push({ message: `supersedes ${old}, which does not exist` });
    else if (o.status !== "accepted") problems.push({ message: `supersedes ${old}, which is ${o.status}, not accepted` });
  }
  if (problems.length) {
    err(`Proposal refused: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    for (const p of problems) err(`  - ${p.message}`);
    return 1;
  }

  // The proposal must be true today.
  const broken = [];
  for (const e of parsed.record.evidence) {
    const res = evaluate(e, repo, config, { run: !!flags.run });
    if (["stale", "violated", "unknown"].includes(res.status)) broken.push(res.message);
  }
  if (broken.length) {
    err("Proposal refused: its evidence does not hold against the code right now");
    for (const b of broken) err(`  - ${b}`);
    err("Fix the evidence (or the code) so the record is true when it is written.");
    return 1;
  }
  if (!parsed.record.evidence.length && record.kind !== "rejected") {
    err("Note: no evidence. Nothing will tell anyone when this record stops being true; add a path, contains, absent, class or command entry if you can.");
  }

  if (flags["dry-run"]) {
    out(content);
    return 0;
  }
  if (repo.exists(file)) throw new UsageError(`${file} already exists`);
  fs.mkdirSync(path.dirname(repo.abs(file)), { recursive: true });
  fs.writeFileSync(repo.abs(file), content);
  out(`Proposed ${id}: ${file}`);
  out("Status: proposed. It is not a rule until a human runs `repo-memory accept " + id + "` and the change passes review.");
  return 0;
}

function reviewer(flags, repo) {
  if (flags.reviewer) return String(flags.reviewer);
  return repo.gitUser() || os.userInfo().username;
}

function review(decision) {
  return function ({ ctx, args, flags, out, err, env }) {
    const { repo, config } = ctx;
    const agent = agentSession(config, env);
    if (agent) {
      err(`Refused: this looks like an agent session (${agent} is set). Agents can propose records; only a human can ${decision} them.`);
      err(`Ask the developer to run: repo-memory ${decision} ${args[0] || "<id>"}`);
      return 1;
    }
    if (args.length !== 1) throw new UsageError(`usage: repo-memory ${decision} <id>`);
    const id = args[0];
    const { records } = loadRecords(repo, config);
    const r = records.find((x) => x.id === id);
    if (!r) throw new UsageError(`${id} not found in ${config.dir}/`);
    if (r.status !== "proposed") {
      err(`${id} is ${r.status}, not proposed.`);
      return 1;
    }
    const by = reviewer(flags, repo);
    const on = today();

    if (decision === "accept") {
      const problems = lint(records, config).filter((i) => i.file === r.file && i.level === "error");
      if (problems.length) {
        err(`Cannot accept ${id}: fix these first`);
        for (const p of problems) err(`  - ${p.message}`);
        return 1;
      }
      const broken = [];
      for (const e of r.evidence) {
        const res = evaluate(e, repo, config, { run: !!flags.run });
        if (["stale", "violated", "unknown"].includes(res.status)) broken.push(res.message);
      }
      if (broken.length) {
        err(`Cannot accept ${id}: its evidence does not hold against the code right now`);
        for (const b of broken) err(`  - ${b}`);
        return 1;
      }
      const olds = (r.data.supersedes || []).map((oid) => records.find((x) => x.id === oid));
      const missing = (r.data.supersedes || []).filter((oid, i) => !olds[i]);
      if (missing.length) {
        err(`Cannot accept ${id}: it supersedes ${missing.join(", ")}, which do not exist`);
        return 1;
      }
      updateRecordFile(repo, r, { status: "accepted", reviewed: { by, on } });
      for (const o of olds) updateRecordFile(repo, o, { status: "superseded", superseded_by: id });
      out(`Accepted ${id} (reviewed by ${by}).${olds.length ? ` Superseded: ${olds.map((o) => o.id).join(", ")}.` : ""}`);
    } else {
      updateRecordFile(repo, r, { status: "rejected", reviewed: { by, on } });
      out(`Rejected ${id} (reviewed by ${by}). It stays in the log so the same idea isn't proposed again.`);
    }
    out("Commit the change in a pull request so the decision is reviewed where code is.");
    return 0;
  };
}

module.exports = { propose, accept: review("accept"), reject: review("reject"), parseProposal };
