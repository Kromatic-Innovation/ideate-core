// Tests for public-safe-lint.sh — the portable, org-agnostic file-shape
// scanner copied verbatim into adopting repositories.
//
// NOTE FOR EDITORS: this repository lints itself with the very scanner under
// test, so this file must contain no matchable instance of any shape it
// checks for. Every known-bad fixture below is therefore assembled from
// fragments at runtime and written into a temp directory; never paste a whole
// bad-shape literal into this source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCANNER = path.join(HERE, "public-safe-lint.sh");

// Known-bad seeds, split so this source file is not itself a hit.
const BAD = {
  absUsersPath: "/Us" + "ers/exampleuser/scratch/file.txt",
  tildePath: "~" + "/scratch/example-file.txt",
  bareIssueRef: "see " + "#" + "4321 for context",
  plusAliasEmail: "tester" + "+alias@example.com",
  agreedWithInitials: "agreed wi" + "th TK on this",
  perNamedRequest: "per Ali" + "ce's request",
  gitdirPointer: "gitdir: " + "/Us" + "ers/exampleuser/repo/.git/worktrees/wt",
};

function mkTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.endsWith("\n") ? body : body + "\n");
  }
  return dir;
}

/** Run the scanner (or a variant of it) and capture status + combined output. */
function scan(root, { config, scanner = SCANNER } = {}) {
  const env = { ...process.env };
  delete env.PUBLIC_SAFE_LINT_CONFIG;
  if (config) env.PUBLIC_SAFE_LINT_CONFIG = config;
  try {
    const stdout = execFileSync("bash", [scanner, root], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout };
  } catch (err) {
    return {
      status: err.status,
      out: (err.stdout || "") + (err.stderr || ""),
    };
  }
}

function writeConfig(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-conf-"));
  const p = path.join(dir, "lint.conf");
  fs.writeFileSync(p, body);
  return p;
}

// --- Baseline: no config at all -------------------------------------------

test("no config: all seven rules run and the canary names seven active rules", () => {
  const tree = mkTree({ "ok.md": "nothing interesting here" });
  const r = scan(tree);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /canary: ok \(known-bad seed matched by 7 of 7 active rule\(s\)\)/);
  assert.match(r.out, /^rules evaluated: 7$/m);
  assert.match(r.out, /verdict:\s+clean against 7 rule\(s\)/);
  // No config was supplied, so the run log mentions none.
  assert.doesNotMatch(r.out, /^config:/m);
  assert.doesNotMatch(r.out, /^rules disabled:/m);
});

test("no config: every rule still catches its own shape", () => {
  const cases = [
    ["local-absolute-path-users", BAD.absUsersPath],
    ["tilde-rooted-path", BAD.tildePath],
    ["bare-issue-ref", BAD.bareIssueRef],
    ["plus-alias-email", BAD.plusAliasEmail],
    ["personal-attribution-agreed-with", BAD.agreedWithInitials],
    ["personal-attribution-per-request", BAD.perNamedRequest],
  ];
  for (const [rule, body] of cases) {
    const r = scan(mkTree({ "bad.md": body }));
    assert.equal(r.status, 1, `${rule} should fail the scan\n${r.out}`);
    assert.ok(r.out.includes(`FAIL [${rule}]`), `${rule} did not fire:\n${r.out}`);
  }
});

test("no config: the scanner never prints the matched text", () => {
  const r = scan(mkTree({ "bad.md": BAD.absUsersPath }));
  assert.equal(r.status, 1);
  assert.ok(!r.out.includes("exampleuser"), r.out);
});

// --- Defect 2: personal-attribution rules were case-blind ------------------

test("defect 2: 'disagreed with the ...' is no longer a hit", () => {
  const r = scan(mkTree({ "prose.md": "We disagreed with the shipped code." }));
  assert.equal(r.status, 0, r.out);
});

test("defect 2: real initials after 'agreed with' still are a hit", () => {
  const r = scan(mkTree({ "notes.md": BAD.agreedWithInitials }));
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("FAIL [personal-attribution-agreed-with]"), r.out);
});

test("defect 2: per-request rule ignores an all-lowercase word", () => {
  // The rule means `per <Given-name>'s request`. Under the old
  // case-insensitive scan the capital in [A-Z] meant nothing, so an ordinary
  // lowercase noun in that slot fired it. This fixture must stay a phrase the
  // buggy form DOES match, or it guards nothing.
  const r = scan(mkTree({ "prose.md": "Shipped per user's request, not ours." }));
  assert.equal(r.status, 0, r.out);
});

test("defect 2: per-request rule still catches a capitalised given name", () => {
  const r = scan(mkTree({ "notes.md": BAD.perNamedRequest }));
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("FAIL [personal-attribution-per-request]"), r.out);
});

test("defect 2: a sentence-initial capital still matches both rules", () => {
  const capitalised = [
    ["personal-attribution-agreed-with", "A" + BAD.agreedWithInitials.slice(1)],
    ["personal-attribution-per-request", "P" + BAD.perNamedRequest.slice(1)],
  ];
  for (const [rule, body] of capitalised) {
    const r = scan(mkTree({ "notes.md": body }));
    assert.equal(r.status, 1, `${rule}\n${r.out}`);
    assert.ok(r.out.includes(`FAIL [${rule}]`), `${rule}\n${r.out}`);
  }
});

// --- Defect 3: `.git` as a FILE (the git-worktree case) --------------------

test("defect 3: a `.git` FILE holding a gitdir pointer is skipped", () => {
  const tree = mkTree({ ".git": BAD.gitdirPointer, "README.md": "hello" });
  const r = scan(tree);
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes("local-absolute-path-users"), r.out);
});

test("defect 3: a `.git` DIRECTORY is still skipped too", () => {
  const tree = mkTree({ ".git/config": BAD.absUsersPath, "README.md": "hello" });
  const r = scan(tree);
  assert.equal(r.status, 0, r.out);
});

// --- Config surface --------------------------------------------------------

test("config: a sidecar file at the scan root scopes a rule out", () => {
  const tree = mkTree({
    "notes.md": BAD.bareIssueRef,
    ".public-safe-lint.conf":
      "# public tracker, so a bare ref resolves\ndisable = bare-issue-ref\n",
  });
  const r = scan(tree);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /canary: ok \(known-bad seed matched by 6 of 6 active rule\(s\)\)/);
  assert.match(r.out, /^rules evaluated: 6 of 7$/m);
  assert.match(r.out, /^rules disabled:\s+bare-issue-ref$/m);
  assert.match(r.out, /verdict:\s+clean against 6 rule\(s\)/);
});

test("config: a scoped rule set leaves the other rules enforcing", () => {
  const tree = mkTree({
    "notes.md": `${BAD.bareIssueRef}\n${BAD.absUsersPath}\n`,
    ".public-safe-lint.conf": "disable = bare-issue-ref\n",
  });
  const r = scan(tree);
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("FAIL [local-absolute-path-users]"), r.out);
  assert.ok(!r.out.includes("FAIL [bare-issue-ref]"), r.out);
});

test("config: PUBLIC_SAFE_LINT_CONFIG scopes a tree without writing into it", () => {
  const tree = mkTree({ "notes.md": BAD.bareIssueRef });
  const before = fs.readdirSync(tree).sort();
  const r = scan(tree, { config: writeConfig("disable = bare-issue-ref\n") });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(fs.readdirSync(tree).sort(), before);
});

test("config: exclude-dir and exclude skip paths", () => {
  const tree = mkTree({
    "vendor/dep.md": BAD.absUsersPath,
    "build/app.min.js": BAD.tildePath,
    "src/ok.md": "fine",
  });
  assert.equal(scan(tree).status, 1);
  const r = scan(tree, {
    config: writeConfig("exclude-dir = vendor\nexclude = *.min.js\n"),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^extra excludes:.*--exclude-dir=vendor.*--exclude=\*\.min\.js/m);
});

test("config: comma-separated and repeated keys both work", () => {
  const tree = mkTree({ "notes.md": `${BAD.bareIssueRef}\n${BAD.tildePath}\n` });
  const r = scan(tree, {
    config: writeConfig("disable = bare-issue-ref, tilde-rooted-path\n"),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /matched by 5 of 5 active rule\(s\)/);

  const r2 = scan(tree, {
    config: writeConfig("disable = bare-issue-ref\ndisable = tilde-rooted-path\n"),
  });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /matched by 5 of 5 active rule\(s\)/);
});

test("config: an unknown key is a hard error, not a silent half-apply", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const r = scan(tree, { config: writeConfig("disabel = bare-issue-ref\n") });
  assert.equal(r.status, 1);
  assert.match(r.out, /unknown key 'disabel'/);
});

test("config: an unknown rule name is a hard error", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const r = scan(tree, { config: writeConfig("disable = bare-issue-refs\n") });
  assert.equal(r.status, 1);
  assert.match(r.out, /is not a rule name/);
});

test("config: a value outside the permitted charset is rejected", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const r = scan(tree, { config: writeConfig("exclude-dir = $(touch pwned)\n") });
  assert.equal(r.status, 1);
  assert.match(r.out, /outside \[A-Za-z0-9\._\*\?\/-\]/);
});

test("config: a value that looks like a further grep option is rejected", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const r = scan(tree, { config: writeConfig("exclude-dir = -r\n") });
  assert.equal(r.status, 1);
  assert.match(r.out, /may not begin with '-'/);
});

test("config: a missing PUBLIC_SAFE_LINT_CONFIG path is a hard error", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const r = scan(tree, { config: path.join(tree, "nope.conf") });
  assert.equal(r.status, 1);
  assert.match(r.out, /points at no such file/);
});

// --- The two floors that make a scoped config safe to trust ---------------

test("floor 1: disabling every rule fails the run rather than reporting clean", () => {
  const tree = mkTree({ "ok.md": "fine" });
  const all = [
    "local-absolute-path-users",
    "local-absolute-path-home",
    "tilde-rooted-path",
    "bare-issue-ref",
    "plus-alias-email",
    "personal-attribution-agreed-with",
    "personal-attribution-per-request",
  ].join(",");
  const r = scan(tree, { config: writeConfig(`disable = ${all}\n`) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /every rule is disabled/);
  assert.doesNotMatch(r.out, /verdict:\s+clean/);
});

test("floor 2: the canary fails when a single active rule stops working", () => {
  // Corrupt ONE rule's pattern so it can no longer match its own seed. The
  // other six still match theirs, so an "at least one rule matched" canary
  // would wave this through — this asserts the per-rule form.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-mut-"));
  const mutated = path.join(dir, "public-safe-lint.sh");
  const src = fs.readFileSync(SCANNER, "utf8");
  const broken = src.replace(
    /\$'plus-alias-email\\t.*\\t0\\ti'/,
    () => "$'plus-alias-email\\tzzz-never-matches-anything\\t0\\ti'",
  );
  assert.notEqual(broken, src, "mutation did not apply — update this test");
  fs.writeFileSync(mutated, broken);

  const r = scan(mkTree({ "ok.md": "fine" }), { scanner: mutated });
  assert.equal(r.status, 1, r.out);
  assert.match(
    r.out,
    /CANARY FAILED: rule 'plus-alias-email' did not match its own known-bad seed/,
  );
  assert.doesNotMatch(r.out, /verdict:\s+clean/);
});

test("floor 2: the canary fails when a rule has no known-bad seed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-mut2-"));
  const mutated = path.join(dir, "public-safe-lint.sh");
  const src = fs.readFileSync(SCANNER, "utf8");
  const broken = src.replace("    plus-alias-email) a='tester'; b='+canary@example.com' ;;\n", "");
  assert.notEqual(broken, src, "mutation did not apply — update this test");
  fs.writeFileSync(mutated, broken);

  const r = scan(mkTree({ "ok.md": "fine" }), { scanner: mutated });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no known-bad seed defined for rule 'plus-alias-email'/);
});

// --- Self-application ------------------------------------------------------

test("the scanner's own source is not a hit against its own rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-self-"));
  fs.copyFileSync(SCANNER, path.join(dir, "public-safe-lint.sh"));
  const r = scan(dir);
  assert.equal(r.status, 0, r.out);
});
