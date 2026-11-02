"use strict";

const assert = require("node:assert/strict");
const { test, tmpRepo, record, recordFile } = require("./helpers");

const EVIDENCE = `
  - kind: contains
    path: app/Order.php
    pattern: SoftDeletes
  - kind: absent
    path: "app/**/*.php"
    pattern: forceDelete\\(`;

function setup(t, extra = {}) {
  const repo = tmpRepo({
    "app/Order.php": "<?php\nclass Order { use SoftDeletes; }\n",
    [recordFile("MEM-0001")]: record({ evidence: EVIDENCE }),
    ...extra,
  });
  t.after(() => repo.cleanup());
  return repo;
}

test("passes when evidence holds", async (t) => {
  const repo = setup(t);
  const r = await repo.run(["check"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /OK\s+MEM-0001/);
  assert.match(r.out, /PASS\s+1 ok/);
});

test("VIOLATED when the code breaks the rule", async (t) => {
  const repo = setup(t);
  repo.write("app/Purge.php", "<?php\n$o->forceDelete();\n");
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /VIOLATED\s+MEM-0001\s+\/forceDelete\\\(\/ found in app\/Purge\.php:2/);
});

test("STALE when the anchor is gone", async (t) => {
  const repo = setup(t);
  repo.remove("app/Order.php");
  repo.write("app/Other.php", "<?php\n");
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /STALE\s+MEM-0001\s+path app\/Order\.php matches no files/);
});

test("UNKNOWN fails instead of passing quietly", async (t) => {
  const repo = setup(t, {
    [recordFile("MEM-0001")]: record({ evidence: "  - kind: class\n    name: App\\Models\\Order" }),
  });
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /UNKNOWN\s+MEM-0001\s+class App\\Models\\Order: cannot resolve/);

  // A binary file can't be searched: "absent" must not claim the pattern is absent.
  repo.write(recordFile("MEM-0001"), record({ evidence: "  - kind: absent\n    path: bin/**\n    pattern: secret" }));
  repo.write("bin/blob", Buffer.from([0, 1, 2, 115, 101, 99]));
  const r2 = await repo.run(["check"]);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /UNKNOWN\s+MEM-0001\s+1 file in bin\/\*\* could not be searched/);
});

test("class evidence resolves through composer PSR-4", async (t) => {
  const repo = setup(t, {
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } }, "autoload-dev": { "psr-4": { "Tests\\": "tests/" } } }),
    "app/Support/Money.php": "<?php\nnamespace App\\Support;\n\nfinal readonly class Money {}\n",
    "app/Support/HasTenant.php": "<?php\nnamespace App\\Support;\ntrait HasTenant {}\n",
    [recordFile("MEM-0001")]: record({ evidence: "  - kind: class\n    name: App\\Support\\Money\n  - kind: class\n    name: \\App\\Support\\HasTenant" }),
  });
  assert.equal((await repo.run(["check"])).code, 0);
  repo.write("app/Support/Money.php", "<?php\n// moved away\n");
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /STALE\s+MEM-0001\s+class App\\Support\\Money not found \(looked in app\/Support\/Money\.php\)/);
});

test("command evidence runs only with --run", async (t) => {
  const repo = setup(t, {
    [recordFile("MEM-0001")]: record({ evidence: "  - kind: command\n    run: node -e \"process.exitCode=require('fs').existsSync('ok')?0:3\"" }),
  });
  const skipped = await repo.run(["check"]);
  assert.equal(skipped.code, 0);
  assert.match(skipped.out, /1 command not run \(--run\)/);
  const failing = await repo.run(["check", "--run", "--verbose"]);
  assert.equal(failing.code, 1);
  assert.match(failing.out, /VIOLATED\s+MEM-0001\s+command exited 3/);
  repo.write("ok", "");
  assert.equal((await repo.run(["check", "--run"])).code, 0);
});

test("REVIEW DUE only fails with --strict", async (t) => {
  const repo = setup(t, { [recordFile("MEM-0001")]: record({ evidence: EVIDENCE, extra: "review_by: 2020-01-01" }) });
  const r = await repo.run(["check"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /REVIEW DUE MEM-0001/);
  assert.equal((await repo.run(["check", "--strict"])).code, 1);
});

test("lint catches broken records without hiding the others", async (t) => {
  const repo = setup(t, {
    "docs/decisions/MEM-0002-bad.md": "---\nid: MEM-0002\ntitle: [unclosed\n---\n",
    "docs/decisions/MEM-0003-incomplete.md": "---\nid: MEM-0003\ntitle: Incomplete\nkind: opinion\nstatus: accepted\nscope: [../x]\nrecorded: 2026-02-30\nsource: {by: robot}\nevidence:\n  - kind: magic\n---\n## Rule\nx\n",
    "docs/decisions/README.md": "# Not a record\n",
    "docs/decisions/0001-plain-adr.md": "---\nstatus: accepted\n---\n# A plain ADR without an id\n",
  });
  const r = await repo.run(["check", "--json"]);
  assert.equal(r.code, 1);
  const res = JSON.parse(r.out);
  const msgs = res.lint.map((i) => `${i.file.split("/").pop()}: ${i.message}`);
  for (const want of [
    /MEM-0002-bad\.md: frontmatter: unterminated flow list/,
    /kind 'opinion' is not one of/,
    /scope '\.\.\/x': must not contain '\.\.'/,
    /recorded must be a date/,
    /source\.by must be one of human, agent/,
    /evidence\[0\]: unknown kind 'magic'/,
    /missing '## Why' section/,
  ]) {
    assert.ok(msgs.some((m) => want.test(m)), `expected ${want} in:\n${msgs.join("\n")}`);
  }
  assert.equal(res.records.find((x) => x.id === "MEM-0001").flags.length, 0, "the healthy record is still checked");
  assert.equal(res.summary.skipped_files, 2);
});

test("duplicate ids and broken supersession chains are errors", async (t) => {
  const repo = setup(t, {
    "docs/decisions/MEM-0001-copy.md": record({ evidence: EVIDENCE }),
    [recordFile("MEM-0002", "Old rule")]: record({ id: "MEM-0002", title: "Old rule", status: "superseded", evidence: EVIDENCE, extra: "superseded_by: MEM-0009" }),
  });
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /duplicate id MEM-0001/);
  assert.match(r.out, /superseded_by MEM-0009 does not exist/);
});

test("an agent-sourced record cannot be accepted by editing the file", async (t) => {
  const repo = setup(t, { [recordFile("MEM-0001")]: record({ evidence: EVIDENCE, source: "agent" }) });
  const r = await repo.run(["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /agent-sourced record is accepted without 'reviewed'/);
});

test("--json output is stable and machine-readable", async (t) => {
  const repo = setup(t);
  const res = JSON.parse((await repo.run(["check", "--json"])).out);
  assert.equal(res.version, 1);
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.summary).sort(), [
    "checked", "commands_skipped", "lint_errors", "lint_warnings", "ok", "proposed", "records",
    "review_due", "skipped_files", "stale", "unanchored", "unknown", "violated", "weakened",
  ]);
  assert.equal(res.records[0].evidence[0].status, "ok");
});

test("usage errors exit 2", async (t) => {
  const repo = setup(t);
  assert.equal((await repo.run(["check", "--since", "no-such-ref"])).code, 2);
  assert.equal((await repo.run(["check", "--bogus"])).code, 2);
  assert.equal((await repo.run(["nope"])).code, 2);
  repo.write("repo-memory.json", "{ not json");
  const r = await repo.run(["check"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /repo-memory\.json is not valid JSON/);
});
