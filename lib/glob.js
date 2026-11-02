"use strict";

// Glob matching with the usual semantics, so a scope written for repo-memory means
// the same thing it means to Claude Code rules, Cursor rules and .gitignore readers:
//   *     any characters except '/'
//   **    any characters including '/', so `src/**` matches every file under src
//   ?     one character except '/'
//   {a,b} either alternative
// Paths are always POSIX-style and relative to the repository root.

const cache = new Map();

function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length;
        const slashAfter = glob[i + 2] === "/";
        if (atStart && slashAfter) {
          re += "(?:[^/]*/)*"; // `**/` : zero or more directories
          i += 2;
        } else if (atStart && atEnd) {
          re += ".*";
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  if (braces) throw new Error(`unbalanced '{' in glob '${glob}'`);
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

function hasMagic(glob) {
  return /[*?{]/.test(glob);
}

function normalize(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function matches(glob, filePath) {
  const p = normalize(filePath);
  const g = normalize(glob);
  if (!hasMagic(g)) return p === g || p.startsWith(g + "/");
  return globToRegExp(g).test(p);
}

// A glob is unsafe if it could reach outside the repository.
function validateGlob(glob) {
  const g = String(glob);
  if (!g.trim()) return "empty glob";
  if (/^([A-Za-z]:)?[\\/]/.test(g)) return "must be relative to the repository root";
  if (g.split(/[\\/]/).includes("..")) return "must not contain '..'";
  try {
    globToRegExp(normalize(g));
  } catch (e) {
    return e.message;
  }
  return null;
}

module.exports = { globToRegExp, hasMagic, matches, normalize, validateGlob };
