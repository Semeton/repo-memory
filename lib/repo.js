"use strict";

// Everything that touches the repository: its root, its file list, file contents and
// git history. One instance per command run, with caches, so a check over many
// records reads each file once.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { normalize, hasMagic, globToRegExp } = require("./glob");

const WALK_SKIP = new Set([".git", "node_modules", "vendor", ".hg", ".svn"]);
const MAX_READ_BYTES = 2 * 1024 * 1024; // larger files are skipped by content checks

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function findRoot(start) {
  try {
    return path.resolve(git(start, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return path.resolve(start);
  }
}

class Repo {
  constructor(root) {
    this.root = root;
    this._files = null;
    this._content = new Map();
    this._isGit = null;
  }

  isGit() {
    if (this._isGit === null) {
      try {
        git(this.root, ["rev-parse", "--is-inside-work-tree"]);
        this._isGit = true;
      } catch {
        this._isGit = false;
      }
    }
    return this._isGit;
  }

  abs(rel) {
    return path.join(this.root, ...normalize(rel).split("/"));
  }

  exists(rel) {
    return fs.existsSync(this.abs(rel));
  }

  // Tracked plus untracked-but-not-ignored files. Ignored files (vendor/, build
  // output) are deliberately invisible to globs: evidence should point at source.
  files() {
    if (this._files) return this._files;
    let list = null;
    if (this.isGit()) {
      try {
        list = git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
          .split("\0")
          .filter(Boolean)
          .filter((f) => fs.existsSync(this.abs(f)));
      } catch {
        list = null;
      }
    }
    if (!list) list = this._walk();
    this._files = [...new Set(list.map(normalize))].sort();
    return this._files;
  }

  _walk() {
    const out = [];
    const visit = (dirRel) => {
      let entries;
      try {
        entries = fs.readdirSync(this.abs(dirRel || "."), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (WALK_SKIP.has(e.name)) continue;
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (e.isDirectory()) visit(rel);
        else if (e.isFile()) out.push(rel);
      }
    };
    visit("");
    return out;
  }

  // Files matching a glob. A literal path also matches a directory's contents and
  // ignored files that exist on disk, so `path: vendor/x` still resolves if present.
  glob(pattern) {
    const g = normalize(pattern);
    if (!hasMagic(g)) {
      if (!this.exists(g)) return [];
      const st = fs.statSync(this.abs(g));
      if (st.isFile()) return [g];
      const inside = this.files().filter((f) => f.startsWith(g + "/"));
      return inside.length ? inside : [g];
    }
    const rx = globToRegExp(g);
    return this.files().filter((f) => rx.test(f));
  }

  read(rel) {
    const key = normalize(rel);
    if (this._content.has(key)) return this._content.get(key);
    let text = null;
    try {
      const abs = this.abs(key);
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_READ_BYTES) {
        const buf = fs.readFileSync(abs);
        text = buf.includes(0) ? null : buf.toString("utf8"); // skip binaries
      }
    } catch {
      text = null;
    }
    this._content.set(key, text);
    return text;
  }

  // Changes between `base` and HEAD (merge-base semantics, like a pull request).
  // Returns { changed: [paths], renames: Map(old -> new), deleted: [paths] }.
  diff(base) {
    const out = git(this.root, ["diff", "--name-status", "-M", "-z", `${base}...HEAD`]).split("\0").filter(Boolean);
    const changed = [];
    const deleted = [];
    const renames = new Map();
    for (let i = 0; i < out.length; ) {
      const status = out[i++];
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = normalize(out[i++]);
        const to = normalize(out[i++]);
        changed.push(from, to);
        if (status.startsWith("R")) renames.set(from, to);
      } else {
        const f = normalize(out[i++]);
        changed.push(f);
        if (status === "D") deleted.push(f);
      }
    }
    return { changed: [...new Set(changed)], renames, deleted };
  }

  mergeBase(base) {
    return git(this.root, ["merge-base", base, "HEAD"]).trim();
  }

  // File content at a commit, or null if it did not exist there.
  showAt(commit, rel) {
    try {
      return git(this.root, ["show", `${commit}:${normalize(rel)}`]);
    } catch {
      return null;
    }
  }

  resolveRef(ref) {
    try {
      git(this.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  gitUser() {
    try {
      return git(this.root, ["config", "user.name"]).trim() || null;
    } catch {
      return null;
    }
  }
}

module.exports = { Repo, findRoot, git };
