"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpRepo, record, recordFile } = require("./helpers");

function setup(t) {
  const repo = tmpRepo({
    "app/Modules/Orders/Order.php": "<?php\nclass Order { use SoftDeletes; }\n",
    "routes/api.php": "<?php\n",
    [recordFile("MEM-0001")]: record({ scope: ["app/Modules/Orders/**"], evidence: "  - kind: contains\n    path: app/Modules/Orders/Order.php\n    pattern: SoftDeletes" }),
    [recordFile("MEM-0002", "Middleware order")]: record({ id: "MEM-0002", title: "Middleware order", scope: ["routes/**", "app/**"], evidence: "  - kind: path\n    path: routes/api.php", rule: "Tenant middleware runs first.", why: "Cross-tenant 200 in February." }),
    [recordFile("MEM-0003", "Repository layer")]: record({ id: "MEM-0003", title: "Repository layer", status: "rejected", kind: "rejected", scope: ["app/**"], extra: "reviewed: {by: Ada, on: 2026-01-01}" }),
    [recordFile("MEM-0004", "Unreviewed idea")]: record({ id: "MEM-0004", title: "Unreviewed idea", status: "proposed", scope: ["app/**"] }),
  });
  t.after(() => repo.cleanup());
  return repo;
}

test("for returns live records that apply, once each, and never proposals", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["for", "app/Modules/Orders/Order.php", "./app/Modules/Orders/Other.php"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.match(/\(MEM-0001\)/g).length, 1);
  assert.match(r.out, /MEM-0002/);
  assert.match(r.out, /Rejected: Repository layer/);
  assert.doesNotMatch(r.out, /MEM-0004/);
  assert.match((await repo.run(["for", "docs/x.md"])).out, /No recorded decisions apply/);

  const json = JSON.parse((await repo.run(["for", "routes/api.php", "--json"])).out);
  assert.deepEqual(json.paths[0].records.map((x) => x.id), ["MEM-0002"]);
  assert.equal(json.paths[0].records[0].rule, "Tenant middleware runs first.");
});

test("for warns the agent about broken evidence instead of hiding the record", async (t) => {
  const repo = setup(t);
  repo.remove("routes/api.php");
  repo.write("routes/web.php", "<?php\n");
  const r = await repo.run(["for", "routes/web.php"]);
  assert.match(r.out, /⚠ This record's evidence is broken \(stale: path routes\/api\.php matches no files\)/);
});

test("show and list", async (t) => {
  const repo = setup(t);
  const s = await repo.run(["show", "MEM-0002", "MEM-0099"]);
  assert.equal(s.code, 1);
  assert.match(s.out, /## Rule\n\nTenant middleware runs first\./);
  assert.match(s.err, /MEM-0099: not found/);
  const l = await repo.run(["list", "--status", "proposed,rejected"]);
  assert.match(l.out, /MEM-0003/);
  assert.match(l.out, /MEM-0004/);
  assert.doesNotMatch(l.out, /MEM-0001/);
});

test("export writes path-scoped rules, is idempotent, and --check detects drift", async (t) => {
  const repo = setup(t);
  repo.write(".claude/rules/repo-memory/hand-written.md", "# mine\n");
  repo.write("AGENTS.md", "# AGENTS.md\n\nHand-written guidance.\n");

  const first = await repo.run(["export", "all"]);
  assert.equal(first.code, 0, first.err);
  const claude = repo.read(".claude/rules/repo-memory/MEM-0001.md");
  assert.match(claude, /^---\npaths:\n  - "app\/Modules\/Orders\/\*\*"\n---\n/);
  assert.match(claude, /\*\*Why:\*\* Order numbers must never be reused\./);
  assert.match(repo.read(".cursor/rules/repo-memory/MEM-0002.mdc"), /globs: routes\/\*\*,app\/\*\*\nalwaysApply: false/);
  assert.equal(repo.exists(".claude/rules/repo-memory/MEM-0004.md"), false, "proposals are never exported");

  const agents = repo.read("AGENTS.md");
  assert.match(agents, /^# AGENTS\.md\n\nHand-written guidance\.\n\n<!-- repo-memory:start -->/);
  assert.match(agents, /\| `app\/Modules\/Orders\/\*\*` \| MEM-0001 \|/);
  assert.doesNotMatch(agents, /Soft-delete orders only/, "AGENTS.md gets an index, not the records");

  assert.equal((await repo.run(["export", "all", "--check"])).code, 0);
  assert.match((await repo.run(["export", "all"])).out, /0 written, 0 removed/);

  // Retire MEM-0001: its generated rule goes, the hand-written file stays.
  repo.write(recordFile("MEM-0001"), repo.read(recordFile("MEM-0001")).replace("status: accepted", "status: deprecated"));
  const drift = await repo.run(["export", "all", "--check"]);
  assert.equal(drift.code, 1);
  assert.match(drift.err, /removed\s+\.claude\/rules\/repo-memory\/MEM-0001\.md/);
  await repo.run(["export", "all"]);
  assert.equal(repo.exists(".claude/rules/repo-memory/MEM-0001.md"), false);
  assert.equal(repo.read(".claude/rules/repo-memory/hand-written.md"), "# mine\n");
  assert.equal(repo.read("AGENTS.md").match(/repo-memory:start/g).length, 1, "the block is replaced, not appended");
});
