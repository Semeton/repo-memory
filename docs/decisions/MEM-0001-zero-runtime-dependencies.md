---
id: MEM-0001
title: Zero runtime dependencies
kind: constraint
status: proposed
scope:
  - package.json
  - lib/**
  - bin/**
evidence:
  - kind: absent
    path: package.json
    pattern: "\"(dependencies|optionalDependencies|peerDependencies)\"\\s*:"
  - kind: absent
    path: "{lib,bin}/**/*.js"
    pattern: require\("(?!\.|node:|fs"|path"|os"|child_process")
recorded: 2026-11-02
source:
  by: agent
---

# Zero runtime dependencies

## Rule

Use only the Node standard library at runtime. Do not add `dependencies`, `optionalDependencies` or `peerDependencies`. Dev tooling that never ships is fine if it is truly needed.

## Why

The tool is installed into other teams' repositories and run in their CI with `npx`. Every dependency is a supply-chain risk inside the thing that is supposed to be the trusted check, and a version conflict in someone else's project. The YAML subset in lib/yaml.js exists for this reason.

## Revisit when

A capability is needed that the standard library genuinely cannot provide, and the dependency can be vendored and audited.
