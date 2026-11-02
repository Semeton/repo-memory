"use strict";

// A record's health: its evidence results plus date-based flags. Shared by `check`
// (which gates CI), `for` and the exporters (which warn the agent instead of hiding
// a record whose evidence broke).

const { evaluate, describe } = require("./evidence");

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Flags, most serious first:
//   VIOLATED    evidence exists but the code breaks the rule      fails check
//   STALE       the code the record points at is gone             fails check
//   UNKNOWN     the evidence could not be evaluated               fails check
//   REVIEW DUE  review_by has passed                              fails check --strict
//   UNANCHORED  accepted with no evidence                         reported only
//   SKIPPED     command evidence not run (no --run)               reported only
const ORDER = ["VIOLATED", "STALE", "UNKNOWN", "REVIEW DUE", "UNANCHORED", "SKIPPED"];
const TYPE = { violated: "VIOLATED", stale: "STALE", unknown: "UNKNOWN", skipped: "SKIPPED" };

function health(record, repo, config, options = {}) {
  const flags = [];
  const evidence = [];
  if (record.status === "accepted") {
    for (const e of record.evidence) {
      if (!e || typeof e !== "object") continue;
      const res = evaluate(e, repo, config, options);
      evidence.push({ evidence: e, label: describe(e), ...res });
      if (TYPE[res.status]) flags.push({ type: TYPE[res.status], message: res.message, output: res.output });
    }
    if (!record.evidence.length && record.kind !== "rejected") flags.push({ type: "UNANCHORED", message: "no evidence to check against" });
  }
  const due = record.data.review_by;
  if (record.status === "accepted" && typeof due === "string" && due < (options.today || today())) {
    flags.push({ type: "REVIEW DUE", message: `review_by ${due} has passed` });
  }
  flags.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return { flags, evidence };
}

function isFailing(flag, strict) {
  return ["VIOLATED", "STALE", "UNKNOWN"].includes(flag.type) || (strict && flag.type === "REVIEW DUE");
}

function isBroken(h) {
  return h.flags.some((f) => ["VIOLATED", "STALE", "UNKNOWN"].includes(f.type));
}

module.exports = { health, isFailing, isBroken, today };
