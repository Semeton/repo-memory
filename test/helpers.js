"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const nodeTest = require("node:test");
const { main } = require("../lib/cli");

// Isolate every git call in the test run, the helpers' and the CLI's, from the
// developer's own git configuration. A global commit-signing setup (GPG, 1Password
// SSH signing), a global hooks path or an fsmonitor can make `git commit` wait for
// a prompt that never comes, and the suite hangs with no output.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

// node:test with a per-test timeout, so anything that does hang fails by name
// instead of stalling the run. (`--test-timeout` is not available on Node 18.)
function test(name, fn) {
  return nodeTest(name, { timeout: 60000 }, fn);
}

// A throwaway git repository with a fixed identity, so tests run the same on a
// laptop, in CI, and inside an agent session.
function tmpRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-memory-test-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.hooksPath", os.devNull);
  const repo = {
    dir,
    git,
    write(rel, content) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), "utf8");
    },
    exists(rel) {
      return fs.existsSync(path.join(dir, rel));
    },
    remove(rel) {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    },
    commit(msg = "commit") {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", msg);
    },
    // Run the CLI against this repo. `env` replaces process.env entirely, so an
    // agent-session variable in the test runner's environment can't leak in.
    async run(argv, { env = {}, stdin } = {}) {
      const out = [];
      const err = [];
      const code = await main([...argv, "--cwd", dir], {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        env,
        stdin: stdin === undefined ? "" : stdin,
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}

// A complete record file. `fm` is raw frontmatter lines after the defaults.
function record({ id = "MEM-0001", title = "Orders are never hard-deleted", status = "accepted", kind = "constraint", scope = ["app/**"], evidence = "", extra = "", source = "human", rule = "Soft-delete orders only.", why = "Order numbers must never be reused." } = {}) {
  const lines = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `kind: ${kind}`,
    `status: ${status}`,
    `scope: [${scope.map((s) => JSON.stringify(s)).join(", ")}]`,
  ];
  if (evidence) lines.push("evidence:", evidence.replace(/^\n|\n$/g, ""));
  lines.push("recorded: 2026-01-10", "source:", `  by: ${source}`);
  if (extra) lines.push(extra.replace(/^\n|\n$/g, ""));
  lines.push("---", "", `# ${title}`, "", "## Rule", "", rule, "", "## Why", "", why, "");
  return lines.join("\n");
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function recordFile(id, title = "Orders are never hard-deleted") {
  return `docs/decisions/${id}-${slug(title)}.md`;
}

module.exports = { test, tmpRepo, record, recordFile };
