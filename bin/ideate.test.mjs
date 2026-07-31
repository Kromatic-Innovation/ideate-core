// Tests for bin/ideate.mjs — the standalone CLI. Fully offline: no adapter, no
// model client, no network. The point of these tests is that the CLI must load
// and run from a path containing a space (and other characters URL.pathname
// would percent-encode). They spawn the real bin file from a copied tree whose
// directory name contains a space, so they fail at the pre-fix SHA (module-load
// ENOENT on `..%20package.json`) and pass after.
// Run: node --test bin/ideate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

// Copy the pieces the CLI needs (package.json for --version, lib for the import
// chain, bin for the entrypoint) into a fresh directory whose name contains a
// space, and return the path to the copied bin.
function spacedInstall() {
  const dir = mkdtempSync(join(tmpdir(), "ideate cli test-")); // note the space
  for (const item of ["package.json", "lib", "bin"]) {
    cpSync(join(REPO_ROOT, item), join(dir, item), { recursive: true });
  }
  return { dir, bin: join(dir, "bin", "ideate.mjs") };
}

test("ideate --version exits 0 from a directory whose name contains a space", () => {
  const { dir, bin } = spacedInstall();
  try {
    assert.ok(bin.includes(" "), "test bin path must contain a space");
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    assert.equal(out.trim(), VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ideate --help exits 0 from a spaced path", () => {
  const { dir, bin } = spacedInstall();
  try {
    const out = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    assert.match(out, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fold-only mode returns parseable JSON from a spaced path", () => {
  const { dir, bin } = spacedInstall();
  try {
    const payload = JSON.stringify({
      context: { slug: "demo" },
      humanIdeas: ["a seed idea", "another"],
    });
    const out = execFileSync(process.execPath, [bin], { encoding: "utf8", input: payload });
    const parsed = JSON.parse(out);
    assert.equal(parsed.mode, "fold-only");
    assert.equal(parsed.candidates.length, 2);
    assert.ok(parsed.candidates.every((c) => c.origin === "human"));
    assert.ok(parsed.candidates.every((c) => c.id.startsWith("demo-human-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
