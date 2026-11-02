"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, stringify, setTopLevel, splitFrontmatter, YamlError } = require("../lib/yaml");

test("parses the shapes records use", () => {
  const y = [
    "id: MEM-0001",
    "title: Orders: never hard-deleted # needs quotes? no, ': ' inside is refused below",
  ].join("\n");
  assert.throws(() => parse(y), YamlError);

  const doc = parse(
    [
      "id: MEM-0001",
      'title: "Orders: never hard-deleted"',
      "count: 3",
      "flag: true",
      "empty:",
      "scope: [app/**, 'routes/*.php']",
      "evidence:",
      "  - kind: contains",
      "    path: app/Order.php",
      "    pattern: SoftDeletes # trailing comment",
      "  - kind: path",
      "    path: app/Models",
      "tags:",
      "- a",
      "- b",
      "source:",
      "  by: human",
      "  ref: \"PR #12\"",
      "inline: {by: agent, n: 2}",
    ].join("\n"),
  );
  assert.deepEqual(doc, {
    id: "MEM-0001",
    title: "Orders: never hard-deleted",
    count: 3,
    flag: true,
    empty: null,
    scope: ["app/**", "routes/*.php"],
    evidence: [
      { kind: "contains", path: "app/Order.php", pattern: "SoftDeletes" },
      { kind: "path", path: "app/Models" },
    ],
    tags: ["a", "b"],
    source: { by: "human", ref: "PR #12" },
    inline: { by: "agent", n: 2 },
  });
});

test("keeps regex backslashes in plain and single-quoted scalars", () => {
  assert.equal(parse("p: forceDelete\\(").p, "forceDelete\\(");
  assert.equal(parse("p: 'a\\d+''s'").p, "a\\d+'s");
  assert.equal(parse('p: "a\\\\d+"').p, "a\\d+");
});

test("refuses what it does not support, with a line number", () => {
  for (const [src, re] of [
    ["a: |\n  text", /block scalars/],
    ["a: &x 1", /anchors/],
    ["a: !tag 1", /tags/],
    ["a: 1\na: 2", /duplicate key 'a'/],
    ["a:\n\t- x", /tabs/],
    ["  a: 1", /must not be indented/],
    ["- a", /must be a map/],
    ["a: [1, [2]]", /nested flow/],
    ["a: 'open", /single-quoted/],
  ]) {
    assert.throws(() => parse(src), (e) => e instanceof YamlError && re.test(e.message), src);
  }
  assert.throws(() => parse("a: 1\nb: [x", { lineOffset: 1 }), /line 3/);
});

test("stringify output parses back to the same value", () => {
  const value = {
    id: "MEM-0007",
    title: "Money: integer kobo",
    status: "accepted",
    scope: ["app/**", "database/migrations/**"],
    evidence: [
      { kind: "absent", path: "app/**/*.php", pattern: "floatval\\(|\\(float\\)" },
      { kind: "command", run: 'vendor/bin/pest --filter="money #1"' },
      { kind: "class", name: "App\\Support\\Money" },
    ],
    recorded: "2026-02-01",
    source: { by: "human", ref: "PR #61" },
    review_by: "2027-02-01",
    empty: [],
    reserved: ["true", "null", "yes", "123", "007", "- x", "#x", "a: b", " pad"],
  };
  assert.deepEqual(parse(stringify(value)), value);
});

test("setTopLevel changes one key and leaves the rest of the text alone", () => {
  const src = "id: MEM-1 # keep me\nstatus: proposed\nscope:\n  - a/**\n\n# a comment\nsource:\n  by: agent\n";
  const out = setTopLevel(src, "status", "accepted");
  assert.equal(out, src.replace("status: proposed", "status: accepted"));
  const added = setTopLevel(out, "reviewed", { by: "Ada", on: "2026-11-02" });
  assert.deepEqual(parse(added).reviewed, { by: "Ada", on: "2026-11-02" });
  assert.match(added, /# a comment/);
  const replacedList = setTopLevel(src, "scope", ["b/**", "c/**"]);
  assert.deepEqual(parse(replacedList).scope, ["b/**", "c/**"]);
  assert.match(replacedList, /\n\n# a comment/);
});

test("splitFrontmatter needs --- on the first line", () => {
  assert.equal(splitFrontmatter("# title\n---\na: 1\n---\n"), null);
  const fm = splitFrontmatter("---\na: 1\n---\nbody\n");
  assert.equal(fm.yaml, "a: 1\n");
  assert.equal(fm.body, "body\n");
});
