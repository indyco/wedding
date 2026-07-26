"use strict";

/**
 * Repository hygiene.
 *
 * A single NUL byte in lib/csv.js once made git classify a source file as
 * binary. Binary files can't be line-merged, so a merge dropped an entire
 * change. `.gitattributes` now forces textual treatment, but the real fix is to
 * never commit an invisible byte in the first place — that's what this checks.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

/** Tracked files, so gitignored runtime data and node_modules are skipped. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".ico", ".gif", ".woff", ".woff2", ".db"]);

test("no tracked text file contains a NUL byte", () => {
  const offenders = [];

  for (const rel of trackedFiles()) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // staged deletion

    const buf = fs.readFileSync(abs);
    const at = buf.indexOf(0);
    if (at !== -1) {
      const line = buf.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `NUL byte(s) found — git will treat these as binary and merges will silently drop changes:\n  ${offenders.join(
      "\n  "
    )}\nWrite invisible characters as escape sequences (e.g. "\\u0000") instead of literal bytes.`
  );
});

test("source files declare a git diff attribute", () => {
  // Guards against .gitattributes being dropped: without it, a NUL byte would
  // once again make a file unmergeable.
  const attrs = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  for (const ext of ["*.js", "*.json", "*.md"]) {
    assert.match(attrs, new RegExp(`^\\${ext}\\s+diff`, "m"), `${ext} must be declared diff`);
  }
});
