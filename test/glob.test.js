"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matches, validateGlob } = require("../lib/glob");

test("glob semantics match the usual conventions", () => {
  const cases = [
    ["app/**", "app/Order.php", true],
    ["app/**", "app/Modules/Orders/Order.php", true],
    ["app/**", "application/x.php", false],
    ["app/*.php", "app/Order.php", true],
    ["app/*.php", "app/Models/Order.php", false],
    ["**/*.php", "Order.php", true],
    ["**/*.php", "a/b/c/Order.php", true],
    ["app/**/Models/**", "app/Models/Order.php", true],
    ["app/**/Models/**", "app/Modules/Orders/Models/Order.php", true],
    ["routes/{api,web}.php", "routes/web.php", true],
    ["routes/{api,web}.php", "routes/console.php", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file/.txt", false],
    ["app/Modules", "app/Modules/Orders/Order.php", true], // literal dir covers its contents
    ["app/Modules", "app/ModulesX/a.php", false],
    ["a.b+c", "a.b+c", true],
    ["a.b+c", "aXb+c", false],
  ];
  for (const [glob, file, want] of cases) assert.equal(matches(glob, file), want, `${glob} vs ${file}`);
  assert.equal(matches("app\\**", "app\\x\\y.php"), true, "Windows separators are normalised");
});

test("globs may not leave the repository", () => {
  assert.match(validateGlob("../secrets/**"), /\.\./);
  assert.match(validateGlob("/etc/passwd"), /relative/);
  assert.match(validateGlob("C:\\x"), /relative/);
  assert.match(validateGlob("a/{b"), /unbalanced/);
  assert.equal(validateGlob("app/**"), null);
});
