"use strict";

// Configuration lives in `repo-memory.json` at the repository root. Every key is
// optional; a repo with no config file uses the defaults below.

const fs = require("fs");
const path = require("path");
const { validateGlob } = require("./glob");

const CONFIG_FILE = "repo-memory.json";
const CONFIG_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  // Where records live. ADR-style Markdown files; files without an `id` in their
  // frontmatter (plain ADRs, a README) are left alone.
  dir: "docs/decisions",
  // Prefix and width for ids that `propose` assigns: MEM-0001, MEM-0002, ...
  idPrefix: "MEM",
  idWidth: 4,
  // `accept` and `reject` refuse to run when any of these is set. A speed bump that
  // makes the policy visible to agents; the enforceable gate is code review.
  agentEnv: ["CLAUDECODE", "AI_AGENT", "CURSOR_AGENT", "CODEX_SANDBOX", "GEMINI_CLI", "OPENCODE"],
  // Seconds a `command` evidence entry may run under `check --run`.
  commandTimeout: 300,
});

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
    if (user === null || typeof user !== "object" || Array.isArray(user)) {
      throw new ConfigError(`${CONFIG_FILE} must contain a JSON object`);
    }
  }
  const config = { ...DEFAULTS, ...user, file: fs.existsSync(file) ? CONFIG_FILE : null };

  if (config.version !== CONFIG_VERSION) {
    throw new ConfigError(`${CONFIG_FILE}: version ${config.version} is not supported by this repo-memory (expected ${CONFIG_VERSION})`);
  }
  const dirProblem = validateGlob(config.dir);
  if (typeof config.dir !== "string" || dirProblem || /[*?{]/.test(config.dir)) {
    throw new ConfigError(`${CONFIG_FILE}: "dir" must be a relative directory path${dirProblem ? ` (${dirProblem})` : ""}`);
  }
  config.dir = config.dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (typeof config.idPrefix !== "string" || !/^[A-Z][A-Z0-9]*$/.test(config.idPrefix)) {
    throw new ConfigError(`${CONFIG_FILE}: "idPrefix" must be uppercase letters and digits, starting with a letter`);
  }
  if (!Number.isInteger(config.idWidth) || config.idWidth < 1 || config.idWidth > 8) {
    throw new ConfigError(`${CONFIG_FILE}: "idWidth" must be an integer from 1 to 8`);
  }
  if (!Array.isArray(config.agentEnv) || !config.agentEnv.every((v) => typeof v === "string")) {
    throw new ConfigError(`${CONFIG_FILE}: "agentEnv" must be a list of environment variable names`);
  }
  if (typeof config.commandTimeout !== "number" || config.commandTimeout <= 0) {
    throw new ConfigError(`${CONFIG_FILE}: "commandTimeout" must be a positive number of seconds`);
  }
  const known = new Set([...Object.keys(DEFAULTS), "$schema"]);
  config.unknownKeys = Object.keys(user).filter((k) => !known.has(k));
  return config;
}

module.exports = { loadConfig, ConfigError, CONFIG_FILE, CONFIG_VERSION, DEFAULTS };
