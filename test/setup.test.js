"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test, tmpRepo, record, recordFile } = require("./helpers");
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

test("init points out agent-contract when it is installed", async (t) => {
  const repo = tmpRepo({ ".agent/manifest.yaml": "version: 1\n" });
  t.after(() => repo.cleanup());
  const r = await repo.run(["init"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /agent-contract detected: both tools keep decisions in docs\/decisions\//);
  assert.match(r.out, /Run `agent-contract update` \(0\.10 or newer\)/);
  const plain = tmpRepo();
  t.after(() => plain.cleanup());
  assert.doesNotMatch((await plain.run(["init"])).out, /agent-contract detected/);
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

test("import turns agent-contract's free-form decisions into proposals", async (t) => {
  const log = [
    { ts: "2026-10-14T10:25:00+01:00", decision: "Reset and invite links use opaque 32-byte random tokens looked up by value; set-user-password derives the user from the token, never from a client id", why: "Reset JWTs had the same {id} shape Auth.user accepts: two account-takeover paths", alternatives: "Keep JWTs with a separate secret and typ claim" },
    { ts: "2026-10-14T10:25:00+01:00", decision: "Email links are built from APP_URL, not Referer/Origin", why: "Referer is attacker-controlled" },
    { ts: "2026-10-15T09:00:00Z", role: "generator", task: "add invite flow", provider: "echo", model: "m", tokens: { used: 1, limit: 2, pct: 50 } },
    { ts: "2026-10-16", decision: "Email links are built from APP_URL, not Referer/Origin" },
    { ts: "bad", decision: "Queue retries are capped at 3", alternatives: ["5 retries", "exponential backoff without a cap"], files: ["app/Jobs/SendInvite.php"] },
    { note: "something else entirely" },
  ].map((x) => JSON.stringify(x)).join("\n");
  const repo = tmpRepo({ ".agent/memory/decisions.jsonl": log, [recordFile("MEM-0003", "Existing")]: record({ id: "MEM-0003", title: "Existing", evidence: "  - kind: path\n    path: .agent" }) });
  t.after(() => repo.cleanup());
  const r = await repo.run(["import", path.join(repo.dir, ".agent/memory/decisions.jsonl")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /1 agent-contract run entry skipped/);
  assert.match(r.err, /1 duplicate decision skipped/);
  assert.match(r.err, /3 free-form decisions imported as proposals \(MEM-0004…MEM-0006\)/);
  assert.match(r.err, /line 6: neither a record/);

  const byId = (id) => "docs/decisions/" + fs.readdirSync(path.join(repo.dir, "docs/decisions")).find((f) => f.startsWith(id + "-"));
  const read = (f) => parse(splitFrontmatter(repo.read(f)).yaml);
  const first = byId("MEM-0004");
  const fm = read(first);
  assert.equal(fm.status, "proposed");
  assert.equal(fm.source.by, "agent");
  assert.equal(fm.recorded, "2026-10-14");
  assert.equal(fm.title, "Reset and invite links use opaque 32-byte random tokens looked up by value");
  const body = repo.read(first);
  assert.match(body, /## Rule\n\nReset and invite links use opaque 32-byte random tokens looked up by value; set-user-password derives/);
  assert.match(body, /## Why\n\nReset JWTs had the same/);
  assert.match(body, /## Alternatives considered\n\nKeep JWTs with a separate secret/);

  const third = repo.read(byId("MEM-0006"));
  assert.match(third, /## Why\n\nNot recorded in the original log/);
  assert.match(third, /## Alternatives considered\n\n- 5 retries\n- exponential backoff without a cap/);
  assert.match(third, /## Original log fields\n\n```json\n\{\n  "files": \[/);
  assert.match(read(byId("MEM-0006")).recorded, /^\d{4}-\d{2}-\d{2}$/);

  const check = await repo.run(["check"]);
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /PROPOSED\s+MEM-0004/);
  // A human can accept one as-is (warnings, not errors), ideally after adding scope.
  assert.equal((await repo.run(["accept", "MEM-0005"])).code, 0);
});

test("import skips log lines an existing record already cites", async (t) => {
  const log = ["First decision", "Second decision", "Third decision"].map((d, i) => JSON.stringify({ ts: `2026-10-1${i}`, decision: d, why: "w" })).join("\n");
  const cites = record({ id: "MEM-0001", title: "Second, rewritten", status: "proposed", source: "agent" }).replace("  by: agent", "  by: agent\n  ref: .agent/memory/decisions.jsonl line 2 (2026-10-11)");
  const repo = tmpRepo({ ".agent/memory/decisions.jsonl": log, [recordFile("MEM-0001", "Second rewritten")]: cites });
  t.after(() => repo.cleanup());
  const r = await repo.run(["import", path.join(repo.dir, ".agent/memory/decisions.jsonl")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /1 decision skipped: already converted/);
  assert.match(r.err, /2 free-form decisions imported as proposals \(MEM-0002…MEM-0003\)/);
  const again = await repo.run(["import", path.join(repo.dir, ".agent/memory/decisions.jsonl")]);
  assert.match(again.err, /3 decisions skipped: already converted/, "a second import adds nothing");
});

test("import titles don't break on abbreviations", async (t) => {
  const log = JSON.stringify({ ts: "2026-10-17", decision: "Requirements group by top-level section (e.g. A.5) plus the second level; deeper nodes roll up", why: "w" });
  const repo = tmpRepo({ "log.jsonl": log });
  t.after(() => repo.cleanup());
  const r = await repo.run(["import", path.join(repo.dir, "log.jsonl"), "--dry-run"]);
  assert.match(r.out, /^title: Requirements group by top-level section \(e\.g\. A\.5\) plus the second level$/m);
});

test("the CLI binary runs", () => {
  const { execFileSync } = require("child_process");
  const bin = path.join(__dirname, "..", "bin", "repo-memory.js");
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), version);
  assert.match(execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" }), /Usage: repo-memory <command>/);
  if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o111, "bin is executable");
});
