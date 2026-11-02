"use strict";

// A strict subset of YAML, enough for record frontmatter and nothing more.
//
// Supported: `key: value` maps, nested maps by indentation, block lists (`- item`,
// at the key's indent or deeper), lists of maps, flow lists `[a, b]`, flat flow maps
// `{a: 1}`, plain / single-quoted / double-quoted scalars, full-line and trailing
// comments. Not supported, and reported as an error with its line number: block
// scalars (| and >), anchors, aliases, tags, multi-document streams, tabs as indent.
//
// The point of the subset is that a record either parses to exactly what a reader
// sees, or fails loudly. A full YAML parser would accept more and surprise more.

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/;

function tokenize(text, lineOffset) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1 + lineOffset;
    if (/^\s*(#.*)?$/.test(raw)) return;
    const lead = raw.match(/^\s*/)[0];
    if (lead.includes("\t")) throw new YamlError("tabs are not allowed in indentation", n);
    out.push({ n, indent: lead.length, content: raw.slice(lead.length).replace(/\s+$/, "") });
  });
  return out;
}

// Strip a trailing ` # comment` from a plain value, ignoring '#' inside quotes.
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function splitFlow(inner, n) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += inner[++i] ?? "";
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === "[" || c === "{") {
      throw new YamlError("nested flow collections are not supported", n);
    } else if (c === ",") {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (q) throw new YamlError("unterminated quote", n);
  if (cur.trim()) parts.push(cur.trim());
  else if (parts.length) throw new YamlError("trailing comma in flow collection", n);
  return parts;
}

function scalar(src, n) {
  const s = src.trim();
  if (s === "") return null;
  const c = s[0];
  if (c === '"') {
    const m = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(s);
    if (!m) throw new YamlError("malformed double-quoted string", n);
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      throw new YamlError("invalid escape in double-quoted string", n);
    }
  }
  if (c === "'") {
    const m = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(s);
    if (!m) throw new YamlError("malformed single-quoted string", n);
    return m[1].replace(/''/g, "'");
  }
  const plain = stripComment(s);
  if (plain === "") return null;
  if (plain[0] === "[") {
    if (!plain.endsWith("]")) throw new YamlError("unterminated flow list", n);
    return splitFlow(plain.slice(1, -1), n).map((p) => scalar(p, n));
  }
  if (plain[0] === "{") {
    if (!plain.endsWith("}")) throw new YamlError("unterminated flow map", n);
    const obj = {};
    for (const part of splitFlow(plain.slice(1, -1), n)) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(part);
      if (!m) throw new YamlError(`expected 'key: value' in flow map, got '${part}'`, n);
      if (Object.prototype.hasOwnProperty.call(obj, m[1])) throw new YamlError(`duplicate key '${m[1]}'`, n);
      obj[m[1]] = scalar(m[2] || "", n);
    }
    return obj;
  }
  if (c === "|" || c === ">") throw new YamlError("block scalars (| and >) are not supported; put long text in the record body", n);
  if (c === "&" || c === "*") throw new YamlError("anchors and aliases are not supported", n);
  if (c === "!") throw new YamlError("tags are not supported", n);
  if (c === "@" || c === "`" || c === "%") throw new YamlError(`a value cannot start with '${c}'; quote it`, n);
  if (/:\s/.test(plain) || plain.endsWith(":")) throw new YamlError("a value containing ': ' must be quoted", n);
  if (plain === "~" || plain === "null") return null;
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

function parse(text, { lineOffset = 0 } = {}) {
  const lines = tokenize(text, lineOffset);
  let pos = 0;

  function isItem(ln) {
    return ln.content === "-" || ln.content.startsWith("- ");
  }

  function parseBlockValue(parentIndent, n) {
    // Value after `key:` with nothing on the line: a nested block, or null.
    const next = lines[pos];
    if (!next) return null;
    if (next.indent > parentIndent) return isItem(next) ? parseList(next.indent) : parseMap(next.indent);
    if (next.indent === parentIndent && isItem(next)) return parseList(parentIndent);
    return null;
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError("unexpected indentation", ln.n);
      if (isItem(ln)) {
        // A list at the map's own indent ends the map only when it belongs to a parent key.
        break;
      }
      const m = KEY_RE.exec(ln.content);
      if (!m) throw new YamlError(`expected 'key: value', got '${ln.content}'`, ln.n);
      const key = m[1];
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`duplicate key '${key}'`, ln.n);
      pos++;
      obj[key] = m[2] === undefined || stripComment(m[2]) === "" ? parseBlockValue(indent, ln.n) : scalar(m[2], ln.n);
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError("unexpected indentation", ln.n);
      if (!isItem(ln)) break;
      const rest = ln.content === "-" ? "" : ln.content.slice(2);
      const restTrim = rest.replace(/^ +/, "");
      const contentIndent = indent + 2 + (rest.length - restTrim.length);
      if (restTrim === "" || /^#/.test(restTrim)) {
        pos++;
        const next = lines[pos];
        if (!next || next.indent <= indent) arr.push(null);
        else arr.push(isItem(next) ? parseList(next.indent) : parseMap(next.indent));
      } else if (KEY_RE.test(restTrim) && !/^["'[{]/.test(restTrim)) {
        // `- key: value` starts a map whose keys sit at the content's column.
        lines[pos] = { n: ln.n, indent: contentIndent, content: restTrim };
        arr.push(parseMap(contentIndent));
      } else {
        pos++;
        arr.push(scalar(restTrim, ln.n));
      }
    }
    return arr;
  }

  if (!lines.length) return {};
  if (lines[0].indent !== 0) throw new YamlError("top-level keys must not be indented", lines[0].n);
  if (isItem(lines[0])) throw new YamlError("frontmatter must be a map, not a list", lines[0].n);
  const out = parseMap(0);
  if (pos < lines.length) throw new YamlError(`unexpected content '${lines[pos].content}'`, lines[pos].n);
  return out;
}

// ---------------------------------------------------------------------------
// Serialisation. Output always re-parses to the same value with parse().

const RESERVED = new Set(["true", "false", "null", "~", "yes", "no", "on", "off", "y", "n"]);

function quote(s) {
  const safe =
    /^[A-Za-z0-9_./(][^\n]*$/.test(s) &&
    !/:\s|:$|\s#|^\s|\s$/.test(s) &&
    !RESERVED.has(s.toLowerCase()) &&
    !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) &&
    !/^0\d/.test(s);
  return safe ? s : JSON.stringify(s);
}

function emitScalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return quote(String(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function emitEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    const out = [`${pad}${key}:`];
    for (const item of value) {
      if (isPlainObject(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        entries.forEach(([k, v], i) => {
          const lines = emitEntry(k, v, indent + 4);
          if (i === 0) lines[0] = `${pad}  - ${lines[0].slice(indent + 4)}`;
          out.push(...lines);
        });
        if (!entries.length) out.push(`${pad}  - {}`);
      } else {
        out.push(`${pad}  - ${emitScalar(item)}`);
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...entries.flatMap(([k, v]) => emitEntry(k, v, indent + 2))];
  }
  const s = emitScalar(value);
  return [s === "" ? `${pad}${key}:` : `${pad}${key}: ${s}`];
}

function stringify(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => emitEntry(k, v, 0))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter: `---` on the first line, the map, `---` again, then the body.

function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!m || m.index !== 0) return null;
  const yaml = m[1];
  const body = text.slice(m[0].length);
  return { yaml, body, bodyLine: m[0].split(/\r?\n/).length };
}

// Replace (or append) one top-level key in a frontmatter block, leaving every other
// line, comment and formatting choice untouched. Used for status changes, so a
// human-written record keeps its shape and the PR diff shows only what changed.
function setTopLevel(yamlText, key, value) {
  const lines = yamlText.replace(/\r?\n$/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${key}:`) && KEY_RE.test(l.replace(/\s+$/, "")));
  const replacement = value === undefined ? [] : emitEntry(key, value, 0);
  if (start === -1) {
    if (value === undefined) return lines.join("\n") + "\n";
    return [...lines, ...replacement].join("\n") + "\n";
  }
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== "" && !/^\s/.test(l) && !/^-( |$)/.test(l)) break;
    end++;
  }
  // Keep blank lines that separated this key from the next one.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(start, end - start, ...replacement);
  return lines.join("\n") + "\n";
}

module.exports = { parse, stringify, splitFrontmatter, setTopLevel, YamlError };
