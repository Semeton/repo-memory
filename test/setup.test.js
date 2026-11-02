"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpRepo } = require("./helpers");
const { parse, splitFrontmatter } = require("../lib/yaml");
const { version } = require("../package.json");

test("init is idempotent and pins the evaluator version in CI", async (t) => {
  const repo = tmpRepo();
  t.after(() => repo.cleanup());
  const first = await repo.run(["init", "--ci", "github"]);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(JSON.parse(repo.read("repo-memory.json")), { version: 1, dir: "docs/decisions", idPrefix: "MEM" });
  const wf = repo.read(".github/workflows/repo-memory.yml");
  assert.match(wf, new RegExp(`REPO_MEMORY: "@semeton/repo-memory@${version.replace(/\./g, "\\.")}"`));
  assert.match(wf, /check --since "origin\/\$GITHUB_BASE_REF"/);
  assert.match(wf, /fetch-depth: 0/);
  repo.write("repo-memory.json", '{"version":1,"dir":"adr"}\n');
  const second = await repo.run(["init", "--ci", "github"]);
  assert.match(second.out, /exists\s+repo-memory\.json/);
  assert.equal(repo.read("repo-memory.json"), '{"version":1,"dir":"adr"}\n', "existing files are never overwritten");
  assert.equal((await repo.run(["check"])).code, 0, "an empty repo passes");
});

test("config is validated", async (t) => {
  const repo = tmpRepo();
  t.after(() => repo.cleanup());
  for (const [cfg, re] of [
    [{ version: 2 }, /version 2 is not supported/],
    [{ version: 1, dir: "../up" }, /"dir" must be a relative directory/],
    [{ version: 1, idPrefix: "mem" }, /"idPrefix"/],
  ]) {
    repo.write("repo-memory.json", JSON.stringify(cfg));
    const r = await repo.run(["check"]);
    assert.equal(r.code, 2);
    assert.match(r.err, re);
  }
  repo.write("repo-memory.json", JSON.stringify({ version: 1, dir: "adr", idPrefix: "ADR", idWidth: 3, colour: "blue" }));
  const r = await repo.run(["check"]);
  assert.match(r.out, /unknown config key 'colour'/);
});

const LOG = [
  { id: "ADR-001", kind: "decision", status: "accepted", title: "Modular monolith", rule: "Code lives in modules.", why: "One deployable unit.", scope: ["app/**"], evidence: [{ kind: "path", ref: "app" }, { kind: "test", ref: "tests/ArchTest.php::modules" }], supersedes: [], superseded_by: null, source: { by: "human", who: "lead", ref: "review" }, recorded: "2026-01-08", review_by: "2027-01-08" },
  { id: "F-002", kind: "finding", status: "accepted", title: "Agent finding", rule: "Keep order.", why: "Found while debugging.", scope: ["routes/**"], evidence: [{ kind: "path", ref: "app" }], source: { by: "agent", who: "claude-code", ref: "session" }, recorded: "2026-02-21" },
  { id: "ADR-003", kind: "weird", status: "rejected", title: "Repositories", rule: "Don't.", why: "Doubled the code.", scope: ["app/**"], evidence: [], source: { by: "human" }, recorded: "2025-11-20" },
].map((r) => JSON.stringify(r)).join("\n");

test("import converts a JSONL log without inventing reviews", async (t) => {
  const repo = tmpRepo({ "app/x.php": "<?php\n", "tests/ArchTest.php": "<?php\n", "old.jsonl": LOG });
  t.after(() => repo.cleanup());
  const r = await repo.run(["import", path.join(repo.dir, "old.jsonl")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /F-002: agent-written and accepted, but no human review was recorded/);
  assert.match(r.err, /ADR-003: kind 'weird' mapped to 'finding'/);

  const read = (f) => parse(splitFrontmatter(repo.read(f)).yaml);
  const adr1 = read("docs/decisions/ADR-001-modular-monolith.md");
  assert.deepEqual(adr1.evidence, [
    { kind: "path", path: "app" },
    { kind: "path", path: "tests/ArchTest.php" },
    { kind: "command", run: 'vendor/bin/pest tests/ArchTest.php --filter="modules"' },
  ]);
  assert.equal(read("docs/decisions/F-002-agent-finding.md").status, "proposed");
  assert.match(repo.read("docs/decisions/ADR-001-modular-monolith.md"), /## Why\n\nOne deployable unit\./);

  const check = await repo.run(["check"]);
  assert.equal(check.code, 0, check.out);
  assert.match((await repo.run(["import", path.join(repo.dir, "old.jsonl")])).err, /already exists.*skipped/);
});

test("the CLI binary runs", () => {
  const { execFileSync } = require("child_process");
  const bin = path.join(__dirname, "..", "bin", "repo-memory.js");
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), version);
  assert.match(execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" }), /Usage: repo-memory <command>/);
  if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o111, "bin is executable");
});
