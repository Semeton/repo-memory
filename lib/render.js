"use strict";

// How records read to an agent: the rule first, the reason second, provenance last.
// Kept short on purpose: context that isn't needed costs tokens and attention.

const { describe } = require("./evidence");
const { isBroken } = require("./health");

function warning(h) {
  if (!h) return "";
  if (isBroken(h)) {
    const why = h.flags.filter((f) => ["STALE", "VIOLATED", "UNKNOWN"].includes(f.type)).map((f) => `${f.type.toLowerCase()}: ${f.message}`).join("; ");
    return `> ⚠ This record's evidence is broken (${why}). Verify it against the code before relying on it, and tell the developer.\n\n`;
  }
  if (h.flags.some((f) => f.type === "REVIEW DUE")) {
    return "> Review due: still in force but not re-confirmed. If your change depends on it, tell the developer.\n\n";
  }
  return "";
}

function renderForAgent(record, h, { heading = "###" } = {}) {
  const lines = [];
  const rejected = record.status === "rejected";
  lines.push(`${heading} ${rejected ? "Rejected: " : ""}${record.title} (${record.id})`, "");
  const w = warning(h);
  if (w) lines.push(w.trimEnd(), "");
  if (rejected) lines.push("The team reviewed this and rejected it. Do not reintroduce it or propose it again.", "");
  lines.push(`**Rule:** ${record.rule}`, "", `**Why:** ${record.why}`, "");
  if (record.revisitWhen) lines.push(`**Revisit when:** ${record.revisitWhen}`, "");
  if (record.evidence.length) lines.push(`**Evidence:** ${record.evidence.map((e) => describe(e)).join("; ")}`, "");
  lines.push(`Source: \`${record.file}\``);
  return lines.join("\n") + "\n";
}

function table(rows, headers) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

module.exports = { renderForAgent, table, warning };
