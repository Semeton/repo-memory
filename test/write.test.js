"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpRepo, record, recordFile } = require("./helpers");
const { parse, splitFrontmatter } = require("../lib/yaml");

const AGENT = { CLAUDECODE: "1" };

const DRAFT = `---
title: Orders are never hard-deleted
kind: constraint
scope: [app/**]
evidence:
  - kind: contains
    path: app/Order.php
    pattern: SoftDeletes
---
## Rule

Soft-delete orders only.

## Why

Order numbers must never be reused.
`;

function setup(t, files = {}) {
  const repo = tmpRepo({ "app/Order.php": "<?php\nclass Order { use SoftDeletes; }\n", ...files });
  t.after(() => repo.cleanup());
  return repo;
}

function frontmatter(repo, rel) {
  return parse(splitFrontmatter(repo.read(rel)).yaml);
}

test("an agent proposes; the tool assigns id, status, date and source", async (t) => {
  const repo = setup(t);
  const draft = DRAFT.replace("kind: constraint", "kind: constraint\nid: MEM-9999\nstatus: accepted\nsource: {by: human}");
  const r = await repo.run(["propose"], { env: AGENT, stdin: draft });
  assert.equal(r.code, 0, r.err);
  const fm = frontmatter(repo, recordFile("MEM-0001"));
  assert.equal(fm.id, "MEM-0001");
  assert.equal(fm.status, "proposed");
  assert.equal(fm.source.by, "agent", "an agent session can't claim human authorship");
  assert.match(fm.recorded, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(repo.exists("docs/decisions/MEM-9999-orders-are-never-hard-deleted.md"), false);
});

test("JSON proposals work too, and ids increase", async (t) => {
  const repo = setup(t, { [recordFile("MEM-0004", "Existing")]: record({ id: "MEM-0004", title: "Existing", evidence: "  - kind: path\n    path: app" }) });
  const json = JSON.stringify({ title: "Money is integer kobo", kind: "decision", scope: ["app/**"], evidence: [{ kind: "path", path: "app" }], rule: "Use integers.", why: "Rounding." });
  const r = await repo.run(["propose"], { stdin: json });
  assert.equal(r.code, 0, r.err);
  assert.equal(frontmatter(repo, "docs/decisions/MEM-0005-money-is-integer-kobo.md").source.by, "human");
});

test("a proposal whose evidence doesn't hold today is refused", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["propose"], { stdin: DRAFT.replace("pattern: SoftDeletes", "pattern: Archivable") });
  assert.equal(r.code, 1);
  assert.match(r.err, /evidence does not hold/);
  assert.equal(repo.exists("docs/decisions"), false);
});

test("a proposal missing its rule or why is refused", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["propose"], { stdin: DRAFT.replace(/## Why[\s\S]*/, "") });
  assert.equal(r.code, 1);
  assert.match(r.err, /missing '## Why' section/);
});

test("--dry-run prints without writing", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["propose", "--dry-run"], { stdin: DRAFT });
  assert.equal(r.code, 0);
  assert.match(r.out, /^---\nid: MEM-0001/);
  assert.equal(repo.exists(recordFile("MEM-0001")), false);
});

test("accept and reject refuse inside an agent session", async (t) => {
  const repo = setup(t);
  await repo.run(["propose"], { env: AGENT, stdin: DRAFT });
  for (const env of [{ CLAUDECODE: "1" }, { AI_AGENT: "codex" }, { CURSOR_AGENT: "1" }]) {
    for (const cmd of ["accept", "reject"]) {
      const r = await repo.run([cmd, "MEM-0001"], { env });
      assert.equal(r.code, 1);
      assert.match(r.err, /only a human can/);
    }
  }
  assert.equal(frontmatter(repo, recordFile("MEM-0001")).status, "proposed");
  assert.equal((await repo.run(["accept", "MEM-0001"], { env: { CLAUDECODE: "0" } })).code, 0, "a falsy value is not a session");
});

test("accept records the reviewer and edits only what changes", async (t) => {
  const repo = setup(t);
  await repo.run(["propose"], { env: AGENT, stdin: DRAFT });
  const before = repo.read(recordFile("MEM-0001"));
  const r = await repo.run(["accept", "MEM-0001"]);
  assert.equal(r.code, 0, r.err);
  const after = repo.read(recordFile("MEM-0001"));
  const fm = frontmatter(repo, recordFile("MEM-0001"));
  assert.equal(fm.status, "accepted");
  assert.equal(fm.reviewed.by, "Test Human");
  const removed = before.split("\n").filter((l) => !after.split("\n").includes(l));
  assert.deepEqual(removed, ["status: proposed"]);
  assert.equal((await repo.run(["check"])).code, 0);
  assert.equal((await repo.run(["accept", "MEM-0001"])).code, 1, "already accepted");
});

test("accept refuses a proposal whose evidence broke since it was proposed", async (t) => {
  const repo = setup(t);
  await repo.run(["propose"], { stdin: DRAFT });
  repo.write("app/Order.php", "<?php\nclass Order {}\n");
  const r = await repo.run(["accept", "MEM-0001"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /evidence does not hold/);
});

test("accepting a supersession retires the old record at both ends", async (t) => {
  const repo = setup(t);
  await repo.run(["propose"], { stdin: DRAFT });
  await repo.run(["accept", "MEM-0001"]);
  const next = DRAFT.replace("title: Orders are never hard-deleted", "title: Orders are archived\nsupersedes: [MEM-0001]");
  assert.equal((await repo.run(["propose"], { stdin: next })).code, 0);
  assert.equal((await repo.run(["check"])).code, 0, "a pending supersession is not yet an inconsistency");
  assert.equal((await repo.run(["accept", "MEM-0002"])).code, 0);
  assert.equal(frontmatter(repo, recordFile("MEM-0001")).status, "superseded");
  assert.equal(frontmatter(repo, recordFile("MEM-0001")).superseded_by, "MEM-0002");
  assert.equal((await repo.run(["check"])).code, 0);
});

test("proposing to supersede a record that isn't accepted is refused", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["propose"], { stdin: DRAFT.replace("kind: constraint", "kind: constraint\nsupersedes: [MEM-0042]") });
  assert.equal(r.code, 1);
  assert.match(r.err, /supersedes MEM-0042, which does not exist/);
});

test("reject keeps the record as a 'don't propose again'", async (t) => {
  const repo = setup(t);
  await repo.run(["propose"], { env: AGENT, stdin: DRAFT });
  assert.equal((await repo.run(["reject", "MEM-0001", "--reviewer", "Ada"])).code, 0);
  const fm = frontmatter(repo, recordFile("MEM-0001"));
  assert.equal(fm.status, "rejected");
  assert.deepEqual(fm.reviewed.by, "Ada");
  const r = await repo.run(["for", "app/Order.php"]);
  assert.match(r.out, /Rejected: Orders are never hard-deleted/);
  assert.match(r.out, /Do not reintroduce it/);
});

test("propose reads --file", async (t) => {
  const repo = setup(t);
  const file = path.join(repo.dir, "draft.md");
  fs.writeFileSync(file, DRAFT);
  assert.equal((await repo.run(["propose", "--file", file])).code, 0);
  assert.equal((await repo.run(["propose", "--file", file + ".missing"])).code, 2);
  assert.equal((await repo.run(["propose"])).code, 2, "no input is a usage error");
});
