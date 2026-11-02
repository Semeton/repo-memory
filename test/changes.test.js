"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpRepo, record, recordFile } = require("./helpers");

const EVIDENCE = `
  - kind: contains
    path: app/Order.php
    pattern: SoftDeletes
  - kind: absent
    path: "app/**/*.php"
    pattern: forceDelete\\(`;

function base(t) {
  const repo = tmpRepo({
    "app/Order.php": "<?php\nclass Order { use SoftDeletes; }\n",
    [recordFile("MEM-0001")]: record({ evidence: EVIDENCE }),
  });
  repo.commit("base");
  repo.git("checkout", "-q", "-b", "pr");
  t.after(() => repo.cleanup());
  return repo;
}

test("a PR that removes the evidence its own code would violate is reported", async (t) => {
  const repo = base(t);
  repo.write("app/Purge.php", "<?php\n$o->forceDelete();\n");
  repo.write(recordFile("MEM-0001"), repo.read(recordFile("MEM-0001")).replace(/  - kind: absent\n.*\n.*\n/, ""));
  repo.commit("pr");

  const plain = await repo.run(["check"]);
  assert.equal(plain.code, 0, "on its own, the weakened record checks out: that is the hole");

  const r = await repo.run(["check", "--since", "main"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /WEAKENED\s+MEM-0001/);
  assert.match(r.out, /evidence removed: \{"kind":"absent"/);

  assert.equal((await repo.run(["check", "--since", "main", "--strict"])).code, 1);
  const json = JSON.parse((await repo.run(["check", "--since", "main", "--json"])).out);
  assert.equal(json.summary.weakened, 1);
  assert.equal(json.record_changes[0].type, "WEAKENED");
});

test("deleting an accepted record, narrowing scope, or demoting it is a weakening", async (t) => {
  const repo = base(t);
  repo.write(recordFile("MEM-0002", "Second"), record({ id: "MEM-0002", title: "Second", evidence: EVIDENCE }));
  repo.write(recordFile("MEM-0003", "Third"), record({ id: "MEM-0003", title: "Third", evidence: EVIDENCE, scope: ["app/**", "routes/**"] }));
  repo.commit("more");
  repo.git("branch", "-f", "main");

  repo.remove(recordFile("MEM-0001"));
  repo.write(recordFile("MEM-0002", "Second"), record({ id: "MEM-0002", title: "Second", evidence: EVIDENCE, status: "deprecated" }));
  repo.write(recordFile("MEM-0003", "Third"), record({ id: "MEM-0003", title: "Third", evidence: EVIDENCE, scope: ["app/**"] }));
  repo.commit("weaken");

  const r = await repo.run(["check", "--since", "main", "--json"]);
  const byId = Object.fromEntries(JSON.parse(r.out).record_changes.map((c) => [c.id, c]));
  assert.equal(byId["MEM-0001"].type, "WEAKENED");
  assert.match(byId["MEM-0001"].details[0], /accepted record deleted/);
  assert.equal(byId["MEM-0002"].type, "WEAKENED");
  assert.match(byId["MEM-0002"].details[0], /status accepted -> deprecated/);
  assert.equal(byId["MEM-0003"].type, "WEAKENED");
  assert.match(byId["MEM-0003"].details.join(" "), /scope removed: routes\/\*\*/);
});

test("adding evidence, a new proposal, or a proper supersession is not a weakening", async (t) => {
  const repo = base(t);
  repo.write(recordFile("MEM-0001"), record({ evidence: EVIDENCE + "\n  - kind: path\n    path: app" }));
  repo.write(recordFile("MEM-0005", "New idea"), record({ id: "MEM-0005", title: "New idea", status: "proposed", source: "agent" }));
  repo.commit("pr");
  const res = JSON.parse((await repo.run(["check", "--since", "main", "--json"])).out);
  assert.equal(res.summary.weakened, 0);
  assert.deepEqual(res.record_changes.map((c) => c.type), []);
});

test("a record added straight as accepted is flagged for review", async (t) => {
  const repo = base(t);
  repo.write(recordFile("MEM-0002", "Snuck in"), record({ id: "MEM-0002", title: "Snuck in", evidence: EVIDENCE }));
  repo.commit("pr");
  const r = await repo.run(["check", "--since", "main"]);
  assert.match(r.out, /ADDED\s+MEM-0002/);
});

test("--since limits the evidence check to records the change touches", async (t) => {
  const repo = base(t);
  repo.write(recordFile("MEM-0002", "Elsewhere"), record({ id: "MEM-0002", title: "Elsewhere", scope: ["billing/**"], evidence: "  - kind: path\n    path: billing" }));
  repo.write("billing/x.php", "<?php\n");
  repo.commit("more");
  repo.git("branch", "-f", "main");
  repo.write("app/New.php", "<?php\n");
  repo.commit("touch app");
  const res = JSON.parse((await repo.run(["check", "--since", "main", "--json"])).out);
  assert.deepEqual(res.records.map((r) => r.id), ["MEM-0001"]);
});

test("a renamed anchor gets a hint", async (t) => {
  const repo = base(t);
  repo.git("mv", "app/Order.php", "app/Orders.php");
  repo.commit("rename");
  const r = await repo.run(["check", "--since", "main"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /path app\/Order\.php matches no files \(renamed to app\/Orders\.php in this change\?\)/);
});
