"use strict";

// Programmatic API. The CLI is built on these; other tools (a PR trust layer, an
// editor plugin) can use them without shelling out.

const { createContext, agentSession } = require("./context");
const { Repo, findRoot } = require("./repo");
const { loadConfig, DEFAULTS } = require("./config");
const records = require("./records");
const { evaluate, validateEvidence, describe, EVIDENCE_KINDS } = require("./evidence");
const { health, isFailing, isBroken } = require("./health");
const { matches, globToRegExp } = require("./glob");
const yaml = require("./yaml");
const { main } = require("./cli");

// Records that apply to a path, with their health. The retrieval step, as a function.
function recordsFor(cwd, filePath) {
  const ctx = createContext(cwd);
  const { records: all } = records.loadRecords(ctx.repo, ctx.config);
  return all
    .filter((r) => records.LIVE.includes(r.status) && r.scope.some((g) => typeof g === "string" && matches(g, filePath)))
    .map((r) => ({ record: r, health: health(r, ctx.repo, ctx.config) }));
}

module.exports = {
  main,
  createContext,
  agentSession,
  Repo,
  findRoot,
  loadConfig,
  DEFAULTS,
  loadRecords: records.loadRecords,
  lint: records.lint,
  parseRecordText: records.parseRecordText,
  recordsFor,
  evaluate,
  validateEvidence,
  describe,
  health,
  isFailing,
  isBroken,
  matches,
  globToRegExp,
  yaml,
  STATUSES: records.STATUSES,
  KINDS: records.KINDS,
  LIVE: records.LIVE,
  EVIDENCE_KINDS,
};
