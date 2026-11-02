"use strict";

// What a change did to the records themselves.
//
// The records judge the code, and the same pull request can edit both. A PR that
// deletes the `absent` evidence its own code would violate passes `check` cleanly:
// the evaluator is checking a claim the candidate just rewrote. repo-memory can't
// stop that on its own (the gate is human review of the records folder, e.g.
// CODEOWNERS), but it can make sure the reviewer sees it, by comparing each changed
// record with its version at the merge base.
//
//   WEAKENED  an accepted record lost evidence or scope, left accepted, or was deleted
//   ADDED     a record arrived already accepted (it skipped the propose/accept path)
//   CHANGED   rule, why or other fields changed; worth a look, not a weakening

const { parseRecordText } = require("./records");

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function removed(before, after) {
  const now = new Set((after || []).map(canonical));
  return (before || []).filter((x) => !now.has(canonical(x)));
}

function recordChanges(repo, config, base, diff, records) {
  const mb = repo.mergeBase(base);
  const inDir = (f) => f.startsWith(config.dir + "/") && f.toLowerCase().endsWith(".md");
  const renamedFrom = new Map([...diff.renames].map(([from, to]) => [to, from]));
  const byFile = new Map(records.map((r) => [r.file, r]));
  const seen = new Set();
  const out = [];

  for (const file of diff.changed.filter(inDir)) {
    if (diff.renames.has(file)) continue; // handled under its new name
    const oldFile = renamedFrom.get(file) || file;
    if (seen.has(oldFile)) continue;
    seen.add(oldFile);

    const beforeText = repo.showAt(mb, oldFile);
    const before = beforeText === null ? null : parseRecordText(beforeText, oldFile).record || null;
    const after = byFile.get(file) || null;
    if (!before && !after) continue;

    const id = (after || before).id;
    const details = [];
    let type = "CHANGED";

    if (!before) {
      if (after.status === "accepted") {
        type = "ADDED";
        details.push("added with status accepted; it did not go through propose/accept, so review it as a new rule");
      } else continue; // a new proposal is the normal path
    } else if (!after) {
      if (before.status === "accepted") {
        type = "WEAKENED";
        details.push("accepted record deleted (to retire a rule, mark it deprecated or superseded instead)");
      } else details.push(`${before.status} record deleted`);
    } else {
      const wasLive = before.status === "accepted";
      if (before.status !== after.status) {
        const legit = before.status === "proposed" || (after.status === "superseded" && after.data.superseded_by);
        if (wasLive && !legit) type = "WEAKENED";
        details.push(`status ${before.status} -> ${after.status}`);
      }
      if (wasLive) {
        const lostEvidence = removed(before.evidence, after.evidence);
        if (lostEvidence.length) {
          type = "WEAKENED";
          for (const e of lostEvidence) details.push(`evidence removed: ${canonical(e)}`);
        }
        const lostScope = removed(before.scope, after.scope);
        if (lostScope.length) {
          type = "WEAKENED";
          details.push(`scope removed: ${lostScope.join(", ")}`);
        }
      }
      if (before.rule.trim() !== after.rule.trim()) details.push("rule text changed");
      if (before.why.trim() !== after.why.trim()) details.push("why text changed");
      if (canonical(before.data.review_by) !== canonical(after.data.review_by)) details.push(`review_by ${before.data.review_by || "(none)"} -> ${after.data.review_by || "(none)"}`);
      if (!details.length) continue;
    }
    out.push({ id, file, type, details });
  }
  const order = { WEAKENED: 0, ADDED: 1, CHANGED: 2 };
  return out.sort((a, b) => order[a.type] - order[b.type] || String(a.id).localeCompare(String(b.id)));
}

module.exports = { recordChanges, canonical };
