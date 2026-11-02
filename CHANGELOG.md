# Changelog

All notable changes to `@semeton/repo-memory`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/): while the version is 0.x, a minor release may change behaviour. Exit codes and the `--json` shape (`version: 1`) change only in a major release.

## [0.1.1] - 2026-11-02

First release published from GitHub Actions through npm trusted publishing, with a provenance attestation linking the package to the commit and workflow run that built it.

### Added

- This changelog, shipped in the package.

### Fixed

- The test suite no longer hangs on machines whose global git config signs commits, sets a hooks path or runs an fsmonitor. Tests now ignore global and system git config, and every git call and every test has a timeout. This affects contributors only; the published CLI is unchanged.

## [0.1.0] - 2026-11-02

Initial release.

- Decision records as Markdown files with checked frontmatter, in `docs/decisions/`.
- Evidence kinds: `path`, `contains`, `absent`, `class` (PHP, through composer PSR-4) and `command`.
- `check` fails on STALE, VIOLATED and UNKNOWN evidence; `--since` reports records a pull request weakened; `--strict` also fails on REVIEW DUE and weakened records.
- Write path: `propose` for anyone, `accept` and `reject` for humans only.
- Delivery: `for <path>`, and `export` to Claude Code rules, Cursor rules and an `AGENTS.md` index.
- `init` with an optional GitHub Actions workflow that pins the evaluator version, and `import` for JSONL decision logs.
- Zero runtime dependencies; Node 18 or newer.

[0.1.1]: https://github.com/Semeton/repo-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Semeton/repo-memory/releases/tag/v0.1.0
