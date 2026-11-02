"use strict";

const path = require("path");
const { Repo, findRoot } = require("./repo");
const { loadConfig } = require("./config");

function createContext(cwd) {
  const root = findRoot(path.resolve(cwd || process.cwd()));
  const repo = new Repo(root);
  const config = loadConfig(root);
  return { root, repo, config };
}

// True when this process looks like it runs inside a coding agent's session.
function agentSession(config, env = process.env) {
  return config.agentEnv.find((k) => env[k] !== undefined && env[k] !== "" && env[k] !== "0") || null;
}

module.exports = { createContext, agentSession };
