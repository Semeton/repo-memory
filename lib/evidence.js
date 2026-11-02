"use strict";

// Evidence: what makes a record true in the code today. Every kind is checked with
// no model involved, so the same commit always gets the same verdict.
//
//   path      { path: <glob> }                      something matching exists
//   contains  { path: <glob>, pattern: <regex> }    some matching file contains the pattern
//   absent    { path: <glob>, pattern: <regex> }    no matching file contains the pattern
//   class     { name: <PHP FQCN> }                  composer PSR-4 resolves it to a file declaring it
//   command   { run: <shell command> }              exits 0 (only executed with `check --run`)
//
// Results:
//   ok        the property was established
//   stale     the anchor is gone: the record may describe code that no longer exists
//   violated  the anchor exists but the code breaks the rule
//   unknown   the property could not be evaluated (no PSR-4 map, unreadable files):
//             never reported as ok, and it fails `check`, because uncertainty
//             silently counted as success is how a gate stops meaning anything
//   skipped   command evidence without --run: reported, and counted as not verified
//
// A result says what was checked, not that the code is correct. `contains` proves a
// pattern is present; it does not prove the rule around it is followed.

const { spawnSync } = require("child_process");
const { validateGlob, matches } = require("./glob");

const EVIDENCE_KINDS = ["path", "contains", "absent", "class", "command"];
const FIELDS = {
  path: { required: ["path"], optional: ["note"] },
  contains: { required: ["path", "pattern"], optional: ["flags", "note"] },
  absent: { required: ["path", "pattern"], optional: ["flags", "note"] },
  class: { required: ["name"], optional: ["note"] },
  command: { required: ["run"], optional: ["timeout", "note"] },
};

function compile(e) {
  const flags = (e.flags || "").replace(/[gmy]/g, "") + "m";
  return new RegExp(e.pattern, flags);
}

function validateEvidence(e) {
  const problems = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["must be a map with a 'kind'"];
  if (!EVIDENCE_KINDS.includes(e.kind)) return [`unknown kind '${e.kind}' (expected ${EVIDENCE_KINDS.join(", ")})`];
  const spec = FIELDS[e.kind];
  for (const f of spec.required) {
    if (typeof e[f] !== "string" || !e[f].trim()) problems.push(`${e.kind} evidence needs a non-empty '${f}'`);
  }
  for (const f of Object.keys(e)) {
    if (f !== "kind" && !spec.required.includes(f) && !spec.optional.includes(f)) problems.push(`unknown field '${f}' for ${e.kind} evidence`);
  }
  if (typeof e.path === "string") {
    const p = validateGlob(e.path);
    if (p) problems.push(`path '${e.path}': ${p}`);
  }
  if (typeof e.pattern === "string") {
    if (e.flags !== undefined && (typeof e.flags !== "string" || !/^[imsu]*$/.test(e.flags))) problems.push("flags may only contain i, m, s, u");
    else {
      try {
        compile(e);
      } catch (err) {
        problems.push(`pattern is not a valid regular expression: ${err.message}`);
      }
    }
  }
  if (e.kind === "class" && typeof e.name === "string" && !/^\\?[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)*$/.test(e.name)) {
    problems.push(`'${e.name}' is not a PHP class name`);
  }
  if (e.timeout !== undefined && (typeof e.timeout !== "number" || e.timeout <= 0)) problems.push("timeout must be a positive number of seconds");
  return problems;
}

function describe(e) {
  switch (e.kind) {
    case "path": return `path ${e.path}`;
    case "contains": return `contains /${e.pattern}/ in ${e.path}`;
    case "absent": return `absent /${e.pattern}/ in ${e.path}`;
    case "class": return `class ${e.name}`;
    case "command": return `command \`${e.run}\``;
    default: return e.kind;
  }
}

// PHP: map a fully-qualified class name to a file through composer.json's PSR-4 map.
function psr4Map(repo) {
  if (repo._psr4 !== undefined) return repo._psr4;
  repo._psr4 = null;
  const text = repo.read("composer.json");
  if (!text) return null;
  try {
    const c = JSON.parse(text);
    const map = [];
    for (const section of [c.autoload, c["autoload-dev"]]) {
      const psr4 = section && section["psr-4"];
      if (!psr4) continue;
      for (const [prefix, dirs] of Object.entries(psr4)) {
        for (const d of [].concat(dirs)) map.push({ prefix, dir: String(d).replace(/\/+$/, "") });
      }
    }
    map.sort((a, b) => b.prefix.length - a.prefix.length);
    repo._psr4 = map;
  } catch {
    repo._psr4 = null;
  }
  return repo._psr4;
}

function checkClass(e, repo) {
  const fqcn = e.name.replace(/^\\/, "");
  const map = psr4Map(repo);
  if (!map) return { status: "unknown", message: `class ${fqcn}: cannot resolve, no composer.json with a PSR-4 autoload map` };
  const short = fqcn.split("\\").pop();
  const decl = new RegExp(`^\\s*(?:(?:abstract|final|readonly)\\s+)*(?:class|interface|trait|enum)\\s+${short}\\b`, "m");
  const tried = [];
  for (const { prefix, dir } of map) {
    if (!fqcn.startsWith(prefix)) continue;
    const rel = `${dir ? dir + "/" : ""}${fqcn.slice(prefix.length).replace(/\\/g, "/")}.php`;
    tried.push(rel);
    const text = repo.read(rel);
    if (text !== null && decl.test(text)) return { status: "ok", locations: [rel] };
  }
  return { status: "stale", message: tried.length ? `class ${fqcn} not found (looked in ${tried.join(", ")})` : `class ${fqcn} is outside every PSR-4 prefix in composer.json` };
}

// Returns { hits, unreadable }: files that matched the glob but could not be read
// (binary, larger than the read limit) are counted, so "no match" is only claimed
// about files that were actually searched.
function findMatches(files, rx, repo, limit = 5) {
  const hits = [];
  let unreadable = 0;
  for (const f of files) {
    const text = repo.read(f);
    if (text === null) {
      unreadable++;
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      rx.lastIndex = 0;
      if (rx.test(lines[i])) hits.push(`${f}:${i + 1}`);
    }
    if (hits.length >= limit) break;
    // Multi-line patterns: fall back to a whole-file test.
    if (!hits.some((h) => h.startsWith(f + ":"))) {
      rx.lastIndex = 0;
      if (rx.test(text)) hits.push(f);
    }
  }
  return { hits, unreadable };
}

// Evaluate one evidence entry. `options.run` enables command evidence;
// `options.renames` (old path -> new path) turns a stale path into a hint.
function evaluate(e, repo, config, options = {}) {
  const renameHint = (glob) => {
    if (!options.renames) return "";
    for (const [from, to] of options.renames) if (matches(glob, from)) return ` (renamed to ${to} in this change?)`;
    return "";
  };
  switch (e.kind) {
    case "path": {
      const found = repo.glob(e.path);
      return found.length ? { status: "ok", locations: found.slice(0, 5) } : { status: "stale", message: `path ${e.path} matches no files${renameHint(e.path)}` };
    }
    case "contains": {
      const files = repo.glob(e.path);
      if (!files.length) return { status: "stale", message: `path ${e.path} matches no files${renameHint(e.path)}` };
      const { hits, unreadable } = findMatches(files, compile(e), repo, 1);
      if (hits.length) return { status: "ok", locations: hits };
      if (unreadable) return { status: "unknown", message: `/${e.pattern}/ not found in the readable files of ${e.path}; ${unreadable} file${unreadable === 1 ? " was" : "s were"} binary or too large to search` };
      return { status: "stale", message: `/${e.pattern}/ not found in ${e.path}` };
    }
    case "absent": {
      const files = repo.glob(e.path);
      if (!files.length) return { status: "stale", message: `path ${e.path} matches no files${renameHint(e.path)}` };
      const { hits, unreadable } = findMatches(files, compile(e), repo, 5);
      if (hits.length) return { status: "violated", message: `/${e.pattern}/ found in ${hits.join(", ")}`, locations: hits };
      if (unreadable) return { status: "unknown", message: `${unreadable} file${unreadable === 1 ? "" : "s"} in ${e.path} could not be searched (binary or too large)` };
      return { status: "ok" };
    }
    case "class":
      return checkClass(e, repo);
    case "command": {
      if (!options.run) return { status: "skipped", message: `command not run (use --run): ${e.run}` };
      const timeout = (e.timeout || config.commandTimeout) * 1000;
      const res = spawnSync(e.run, { cwd: repo.root, shell: true, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
      const tail = `${res.stdout || ""}${res.stderr || ""}`.trim().split("\n").slice(-15).join("\n");
      if (res.error && res.error.code === "ETIMEDOUT") return { status: "violated", message: `command timed out after ${timeout / 1000}s: ${e.run}`, output: tail };
      if (res.error) return { status: "violated", message: `command could not run (${res.error.message}): ${e.run}`, output: tail };
      return res.status === 0 ? { status: "ok" } : { status: "violated", message: `command exited ${res.status}: ${e.run}`, output: tail };
    }
    default:
      return { status: "stale", message: `unknown evidence kind '${e.kind}'` };
  }
}

module.exports = { EVIDENCE_KINDS, validateEvidence, evaluate, describe };
