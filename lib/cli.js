"use strict";

const { createContext } = require("./context");
const { check } = require("./commands/check");
const { forPaths, show, list } = require("./commands/read");
const { propose, accept, reject } = require("./commands/write");
const { exportCommand } = require("./commands/export");
const { init, importCommand } = require("./commands/setup");
const { UsageError } = require("./errors");
const { ConfigError } = require("./config");
const { version } = require("../package.json");

const HELP = `repo-memory ${version}: decision records for coding agents, checked against the code.

Usage: repo-memory <command> [options]

Reading
  for <path>...              Records that apply to these files (what an agent reads before a change)
  show <id>...               Print record files
  list [--status <s,...>]    One line per record

Checking (exit 1 on failure, 2 on usage error)
  check                      Lint all records; check accepted records' evidence against the code
    --run                    Also execute 'command' evidence (tests that enforce a rule)
    --since <ref>            Only records touched by <ref>...HEAD (renames are reported as hints)
    --strict                 Also fail when a record's review_by date has passed
    --verbose                Show skipped commands and failing command output

Writing
  propose --file <f>         Add a proposal from a .md or .json draft (or pipe it on stdin)
    --dry-run                Print the record instead of writing it
  accept <id>                Human only: accept a proposal (its evidence must hold)
  reject <id>                Human only: reject a proposal; it stays as "don't propose again"
    --reviewer <name>        Recorded as the reviewer (default: git user.name)

Delivering to agents
  export <claude|cursor|agents|all>   Write path-scoped rules / the AGENTS.md index
    --check                  Exit 1 if the generated files are out of date

Setup
  init [--dir <d>] [--ci github]      Config, record folder and (optionally) a CI workflow
  import <decisions.jsonl>            Convert a JSONL decision log
    --test-command '<cmd>'            For 'test' evidence; {file} and {filter} are replaced

Global
  --cwd <dir>                Run against another directory (default: current)
  --json                     Machine-readable output (check, for, list)
  -h, --help / -v, --version

Docs: https://github.com/Semeton/repo-memory#readme`;

const COMMANDS = {
  check, for: forPaths, show, list, propose, accept, reject,
  export: exportCommand, init, import: importCommand,
};

const VALUE_FLAGS = new Set(["cwd", "since", "file", "reviewer", "status", "dir", "ci", "test-command"]);
const BOOL_FLAGS = new Set(["run", "strict", "verbose", "json", "check", "dry-run", "help", "version"]);

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined || (eq === -1 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
        flags[name] = value;
      } else if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
        flags[name] = true;
      } else {
        throw new UsageError(`unknown option --${name}`);
      }
    } else args.push(a);
  }
  return { args, flags };
}

// Returns the exit code. All output goes through io so tests can capture it.
async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + "\n"));
  const err = io.err || ((s) => process.stderr.write(s + "\n"));
  const env = io.env || process.env;
  try {
    const { args, flags } = parseArgs(argv);
    if (flags.version) {
      out(version);
      return 0;
    }
    const name = args.shift();
    if (!name || flags.help || name === "help") {
      out(HELP);
      return name || flags.help ? 0 : 2;
    }
    const command = COMMANDS[name];
    if (!command) throw new UsageError(`unknown command '${name}' (run repo-memory --help)`);
    const ctx = createContext(flags.cwd || io.cwd);
    let stdin = io.stdin;
    if (name === "propose" && stdin === undefined && !flags.file && !process.stdin.isTTY) {
      stdin = require("fs").readFileSync(0, "utf8");
    }
    return await command({ ctx, args, flags, out, err, env, stdin });
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError) {
      err(`repo-memory: ${e.message}`);
      return 2;
    }
    err(`repo-memory: internal error: ${e && e.stack ? e.stack : e}`);
    return 2;
  }
}

module.exports = { main, parseArgs, HELP };
