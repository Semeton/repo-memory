"use strict";

// Records: one Markdown file each, YAML frontmatter for the machine-checked fields,
// `## Rule` / `## Why` sections for the words. Loading never throws on a bad record;
// problems become lint issues with a file and line, so one broken file can't hide
// the state of the others.

const fs = require("fs");
const path = require("path");
const yaml = require("./yaml");
const { validateGlob, normalize } = require("./glob");
const { EVIDENCE_KINDS, validateEvidence } = require("./evidence");

const STATUSES = ["proposed", "accepted", "rejected", "superseded", "deprecated"];
const KINDS = ["decision", "constraint", "convention", "finding", "rejected"];
const SOURCES = ["human", "agent"];
// Records an agent should see: accepted rules, and rejected proposals so the same
// wrong idea isn't proposed again.
const LIVE = ["accepted", "rejected"];

// Canonical field order, used when the tool writes a record.
const FIELD_ORDER = [
  "id", "title", "kind", "status", "scope", "evidence", "recorded", "source",
  "review_by", "supersedes", "superseded_by", "reviewed", "tags",
];
const REQUIRED = ["id", "title", "kind", "status", "scope", "recorded", "source"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

function isDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "") || "record";
}

// `## Rule` -> sections.rule, `## Revisit when` -> sections.revisit_when
function parseSections(body) {
  const sections = {};
  const re = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(body))) heads.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  heads.forEach((h, i) => {
    const key = h.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const text = body.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : body.length).trim();
    if (!(key in sections)) sections[key] = text;
  });
  return sections;
}

function parseRecordText(text, file) {
  const fm = yaml.splitFrontmatter(text);
  if (!fm) return { skipped: "no frontmatter" };
  let data;
  try {
    data = yaml.parse(fm.yaml, { lineOffset: 1 });
  } catch (e) {
    return { error: { level: "error", file, line: e.line, message: `frontmatter: ${e.message.replace(/^line \d+: /, "")}` } };
  }
  if (!data || typeof data !== "object" || !("id" in data)) return { skipped: "no id in frontmatter" };
  const sections = parseSections(fm.body);
  return {
    record: {
      id: data.id,
      file,
      data,
      body: fm.body,
      bodyLine: fm.bodyLine,
      sections,
      title: data.title,
      kind: data.kind,
      status: data.status,
      scope: Array.isArray(data.scope) ? data.scope : [],
      evidence: Array.isArray(data.evidence) ? data.evidence : [],
      rule: sections.rule || "",
      why: sections.why || "",
      revisitWhen: sections.revisit_when || "",
    },
  };
}

function listRecordFiles(repo, dir) {
  const absDir = repo.abs(dir);
  if (!fs.existsSync(absDir)) return [];
  const out = [];
  const visit = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(path.join(abs, e.name), r);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(r);
    }
  };
  visit(absDir, dir);
  return out.sort();
}

// Load every record under the configured directory.
// Returns { records, skipped: [file], issues: [lint issue] }.
function loadRecords(repo, config) {
  const records = [];
  const skipped = [];
  const issues = [];
  for (const file of listRecordFiles(repo, config.dir)) {
    const text = fs.readFileSync(repo.abs(file), "utf8");
    const res = parseRecordText(text, file);
    if (res.skipped) skipped.push(file);
    else if (res.error) issues.push(res.error);
    else records.push(res.record);
  }
  return { records, skipped, issues };
}

function lint(records, config) {
  const issues = [];
  const byId = new Map();
  const add = (level, r, message) => issues.push({ level, file: r.file, id: typeof r.id === "string" ? r.id : undefined, message });

  for (const r of records) {
    const d = r.data;
    for (const f of REQUIRED) {
      if (d[f] === undefined || d[f] === null || d[f] === "") add("error", r, `missing required field '${f}'`);
    }
    if (d.id !== undefined && d.id !== null) {
      if (typeof d.id !== "string" || !ID_RE.test(d.id)) add("error", r, `id '${d.id}' must look like PREFIX-123`);
      else {
        if (byId.has(d.id)) add("error", r, `duplicate id ${d.id} (also in ${byId.get(d.id).file})`);
        else byId.set(d.id, r);
        const base = path.posix.basename(r.file);
        if (!base.startsWith(`${d.id}-`) && base !== `${d.id}.md`) add("warning", r, `file name should start with '${d.id}-'`);
      }
    }
    if (d.title !== undefined && (typeof d.title !== "string" || !d.title.trim())) add("error", r, "title must be a non-empty string");
    if (d.kind !== undefined && d.kind !== null && !KINDS.includes(d.kind)) add("error", r, `kind '${d.kind}' is not one of ${KINDS.join(", ")}`);
    if (d.status !== undefined && d.status !== null && !STATUSES.includes(d.status)) add("error", r, `status '${d.status}' is not one of ${STATUSES.join(", ")}`);
    if (d.recorded !== undefined && d.recorded !== null && !isDate(d.recorded)) add("error", r, "recorded must be a date (YYYY-MM-DD)");
    if (d.review_by !== undefined && d.review_by !== null && !isDate(d.review_by)) add("error", r, "review_by must be a date (YYYY-MM-DD)");

    if (d.scope !== undefined && d.scope !== null) {
      if (!Array.isArray(d.scope)) add("error", r, "scope must be a list of globs");
      else {
        if (!d.scope.length && LIVE.includes(d.status)) add("warning", r, "scope is empty: no file will retrieve this record (use \"**\" for repo-wide)");
        d.scope.forEach((g) => {
          const p = typeof g === "string" ? validateGlob(g) : "must be a string";
          if (p) add("error", r, `scope '${g}': ${p}`);
        });
      }
    }

    if (d.source !== undefined && d.source !== null) {
      if (typeof d.source !== "object" || Array.isArray(d.source)) add("error", r, "source must be a map with 'by' (human|agent)");
      else if (!SOURCES.includes(d.source.by)) add("error", r, `source.by must be one of ${SOURCES.join(", ")}`);
    }

    if (d.evidence !== undefined && d.evidence !== null && !Array.isArray(d.evidence)) add("error", r, "evidence must be a list");
    (Array.isArray(d.evidence) ? d.evidence : []).forEach((e, i) => {
      for (const p of validateEvidence(e)) add("error", r, `evidence[${i}]: ${p}`);
    });
    if (d.status === "accepted" && d.kind !== "rejected" && Array.isArray(d.evidence) && d.evidence.length === 0) {
      add("warning", r, "no evidence: nothing can tell when this record stops being true");
    }

    if (!r.rule.trim()) add("error", r, "missing '## Rule' section");
    if (!r.why.trim()) add("error", r, "missing '## Why' section");

    if (d.reviewed !== undefined && d.reviewed !== null) {
      if (typeof d.reviewed !== "object" || !d.reviewed.by || !isDate(d.reviewed.on)) add("error", r, "reviewed must be { by: <name>, on: <date> }");
    }
    if (d.status === "accepted" && !d.reviewed && d.source && d.source.by === "agent") {
      add("error", r, "agent-sourced record is accepted without 'reviewed' (accept it with `repo-memory accept`)");
    }
    if (d.supersedes !== undefined && d.supersedes !== null && !Array.isArray(d.supersedes)) add("error", r, "supersedes must be a list of ids");
    if (d.tags !== undefined && d.tags !== null && !Array.isArray(d.tags)) add("error", r, "tags must be a list");

    for (const key of Object.keys(d)) {
      if (!FIELD_ORDER.includes(key) && !key.startsWith("x-")) add("warning", r, `unknown field '${key}' (prefix custom fields with 'x-')`);
    }
  }

  // Supersession must agree at both ends, or the history is lying.
  for (const r of records) {
    const d = r.data;
    if (d.status === "superseded") {
      const next = byId.get(d.superseded_by);
      if (!d.superseded_by) add("error", r, "status is superseded but superseded_by is empty");
      else if (!next) add("error", r, `superseded_by ${d.superseded_by} does not exist`);
      else if (!(next.data.supersedes || []).includes(d.id)) add("error", r, `superseded_by ${d.superseded_by}, but ${d.superseded_by} does not list it in supersedes`);
    } else if (d.superseded_by) {
      add("error", r, `superseded_by is set but status is '${d.status}'`);
    }
    if (d.status !== "proposed" && Array.isArray(d.supersedes)) {
      for (const old of d.supersedes) {
        const o = byId.get(old);
        if (!o) add("error", r, `supersedes ${old}, which does not exist`);
        else if (d.status === "accepted" && o.data.status !== "superseded") add("error", r, `supersedes ${old}, but ${old} is not marked superseded`);
      }
    }
  }
  return issues;
}

function nextId(records, config) {
  const prefix = `${config.idPrefix}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) max = Math.max(max, Number(r.id.slice(prefix.length)) || 0);
  }
  return `${prefix}${String(max + 1).padStart(config.idWidth, "0")}`;
}

// Order a record's fields canonically and render it as a complete Markdown file.
function renderRecordFile(data, sections) {
  const ordered = {};
  for (const k of FIELD_ORDER) if (data[k] !== undefined && data[k] !== null) ordered[k] = data[k];
  for (const k of Object.keys(data)) if (!(k in ordered) && data[k] !== undefined && data[k] !== null) ordered[k] = data[k];
  const parts = [`---\n${yaml.stringify(ordered)}\n---\n`, `# ${data.title}\n`];
  parts.push(`## Rule\n\n${sections.rule.trim()}\n`);
  parts.push(`## Why\n\n${sections.why.trim()}\n`);
  if (sections.revisit_when && sections.revisit_when.trim()) parts.push(`## Revisit when\n\n${sections.revisit_when.trim()}\n`);
  for (const [k, v] of Object.entries(sections)) {
    if (["rule", "why", "revisit_when"].includes(k) || !v || !String(v).trim()) continue;
    const heading = k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    parts.push(`## ${heading}\n\n${String(v).trim()}\n`);
  }
  return parts.join("\n");
}

// Rewrite selected top-level frontmatter keys of an existing record file in place.
function updateRecordFile(repo, record, changes) {
  const abs = repo.abs(record.file);
  const text = fs.readFileSync(abs, "utf8");
  const fm = yaml.splitFrontmatter(text);
  let y = fm.yaml;
  for (const [k, v] of Object.entries(changes)) y = yaml.setTopLevel(y, k, v);
  const updated = `---\n${y.replace(/\n*$/, "\n")}---\n${fm.body}`;
  // Guard: the edit must round-trip to exactly the intended data.
  const check = parseRecordText(updated, record.file);
  if (!check.record) throw new Error(`internal error: rewriting ${record.file} produced an unreadable record`);
  fs.writeFileSync(abs, updated);
  return check.record;
}

function recordPath(config, id, title) {
  return `${config.dir}/${id}-${slugify(title)}.md`;
}

module.exports = {
  STATUSES, KINDS, LIVE, FIELD_ORDER, EVIDENCE_KINDS,
  loadRecords, lint, parseRecordText, parseSections, nextId, renderRecordFile, updateRecordFile,
  recordPath, slugify, isDate, normalize,
};
