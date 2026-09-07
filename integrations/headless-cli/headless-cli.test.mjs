// Tests for the headless-CLI adapter. Fully hermetic: child_process.spawn is
// injected with a scripted fake, so no real `claude` CLI, process, or network is
// touched. Run by the root `node --test` (recursive discovery).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createHeadlessCliComplete,
  assertHeadlessCliAvailable,
  defaultExtractText,
  runProcess,
  HeadlessCliError,
} from "./index.mjs";
import { ideateCore } from "../../lib/ideate-core.mjs";

// ── Fake spawn ───────────────────────────────────────────────────────────────
function makeStream() {
  const s = new EventEmitter();
  s.setEncoding = () => {};
  return s;
}

/**
 * @param {object} script
 *   errorEvent? Error emitted as the child's 'error' (e.g. ENOENT)
 *   stdout?/stderr? strings emitted before close
 *   code?/signal? close args (default 0/null)
 *   neverClose? if true, don't auto-close (for timeout tests; kill() closes it)
 */
function makeFakeSpawn(script = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const call = { command, args, opts, input: "" };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = makeStream();
    child.stderr = makeStream();
    const stdin = new EventEmitter();
    stdin.end = (data) => {
      call.input += data == null ? "" : data;
    };
    child.stdin = stdin;
    child.kill = () => {
      child.emit("close", null, "SIGKILL");
    };
    setImmediate(() => {
      if (script.errorEvent) {
        child.emit("error", script.errorEvent);
        return;
      }
      if (script.neverClose) return;
      if (script.stdout != null) child.stdout.emit("data", script.stdout);
      if (script.stderr != null) child.stderr.emit("data", script.stderr);
      child.emit("close", script.code == null ? 0 : script.code, script.signal ?? null);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const enoent = () => Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });

// ── defaultExtractText ───────────────────────────────────────────────────────
test("defaultExtractText pulls `result` from the claude JSON envelope", () => {
  assert.equal(defaultExtractText('{"type":"result","is_error":false,"result":"hello"}'), "hello");
});

test("defaultExtractText falls back to `text`, then raw non-JSON body", () => {
  assert.equal(defaultExtractText('{"text":"via text field"}'), "via text field");
  assert.equal(defaultExtractText("just plain text output"), "just plain text output");
  assert.equal(defaultExtractText("   "), "");
});

test("defaultExtractText throws loudly on is_error=true", () => {
  assert.throws(
    () => defaultExtractText('{"is_error":true,"result":"auth failed"}'),
    (e) =>
      e instanceof HeadlessCliError &&
      /is_error=true/.test(e.message) &&
      /auth failed/.test(e.message),
  );
});

// ── createHeadlessCliComplete happy path ─────────────────────────────────────
test("complete() returns { ok, text } and feeds the prompt on stdin", async () => {
  const spawn = makeFakeSpawn({
    stdout: '{"is_error":false,"result":"[{\\"text\\":\\"idea one\\"}]"}',
    code: 0,
  });
  const complete = createHeadlessCliComplete({ spawn, command: "claude" });
  const res = await complete({ prompt: "PROMPT-BODY" });
  assert.deepEqual(res, { ok: true, text: '[{"text":"idea one"}]' });
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "claude");
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json"]);
  assert.equal(spawn.calls[0].input, "PROMPT-BODY");
});

// ── Routing parity: model / effort forwarding ───────────────────────────────
test("complete() forwards req.model as --model when present", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "opus"]);
});

test("complete() forwards req.effort as --effort when present", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await complete({ prompt: "x", effort: "high" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--effort", "high"]);
});

test("complete() forwards both --model and --effort when both are present", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await complete({ prompt: "x", model: "sonnet", effort: "max" });
  assert.deepEqual(spawn.calls[0].args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--effort",
    "max",
  ]);
});

test("complete() emits no routing flags when neither model nor effort is set", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json"]);
});

test("complete() does not forward temperature or maxTokens (no CLI flag exists)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await complete({ prompt: "x", temperature: 0.7, maxTokens: 4096 });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json"]);
});

// ── Required-flag invariant (ideate-core#152 review, finding 1) ────────────
// `-p`/`--output-format` must survive ANY caller-supplied `options.args`, not
// just the ones every prior test happened to include already. A miss here
// means the real CLI emits prose that `defaultExtractText`'s non-JSON
// fallback returns as `{ok:true, text:"<prose>"}` — no throw, a silently
// junk candidate pool.
test("caller args missing --output-format entirely still get it defaulted to json", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn, args: ["--model", "haiku"] });
  await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["--model", "haiku", "-p", "--output-format", "json"]);
});

test("caller args missing -p entirely still get it added", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn, args: ["--output-format", "json"] });
  await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["--output-format", "json", "-p"]);
});

test("a caller's explicit --output-format text is honored, not overridden to json", async () => {
  const spawn = makeFakeSpawn({ stdout: "plain text reply", code: 0 });
  const complete = createHeadlessCliComplete({ spawn, args: ["-p", "--output-format", "text"] });
  const res = await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "text"]);
  assert.deepEqual(res, { ok: true, text: "plain text reply" });
});

test("a caller's explicit --output-format=text (single-token form) is honored", async () => {
  const spawn = makeFakeSpawn({ stdout: "plain text reply", code: 0 });
  const complete = createHeadlessCliComplete({ spawn, args: ["-p", "--output-format=text"] });
  await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format=text"]);
});

// ── hasFlag positional/alias blindness (ideate-core#153) ───────────────────
// A literal "-p" sitting in another flag's *value* position must not be
// mistaken for a real print flag, and "--print" must be recognized as the
// same flag as "-p" so it isn't duplicated. Both assertions count print-flag
// TOKENS rather than using `.includes("-p")` — an `includes` check would
// pass vacuously here since a stray "-p" is already present in the args
// before injection even runs (case a), or since a lone injected "-p" would
// also make a naive `includes` true even if duplicated (case b).
test("a flag-shaped value token does not defeat print-flag injection (ideate-core#153, finding a)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["--append-system-prompt", "-p"],
  });
  await complete({ prompt: "x" });
  const argv = spawn.calls[0].args;
  const printTokenCount = argv.filter((t) => t === "-p" || t === "--print").length;
  // One real print flag must be injected in addition to the caller's
  // pre-existing literal "-p" (which is --append-system-prompt's value, not
  // a flag occurrence) — so the count must be 2, not 1.
  assert.equal(
    printTokenCount,
    2,
    `expected the caller's literal "-p" value plus one injected real print flag: ${JSON.stringify(argv)}`,
  );
  assert.ok(argv.includes("--output-format"), `--output-format missing: ${JSON.stringify(argv)}`);
});

test("--print is recognized as an alias of -p, so no duplicate is injected (ideate-core#153, finding b)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["--print", "--output-format", "json"],
  });
  await complete({ prompt: "x" });
  const argv = spawn.calls[0].args;
  const printTokenCount = argv.filter((t) => t === "-p" || t === "--print").length;
  assert.equal(printTokenCount, 1, `expected no duplicate print flag: ${JSON.stringify(argv)}`);
  assert.deepEqual(argv, ["--print", "--output-format", "json"]);
});

// `hasPrintFlag`'s value-position conservatism (finding a's fix) has a known,
// accepted false-negative: a REAL boolean flag other than `-p`/`--print`
// (e.g. `--verbose`, confirmed via `claude --help`) immediately before a
// genuine `-p` makes `hasPrintFlag` treat that `-p` as if it were
// `--verbose`'s value and under-count it, injecting a harmless duplicate
// that the code before ideate-core#153 would not have added. This is the one behavioral
// regression this fix introduces — proven harmless at the CLI-parser level
// (see the `hasPrintFlag` doc comment), but pinning the EXACT argv here so a
// future change to `hasPrintFlag` cannot silently alter this without a test
// noticing.
test("a real boolean flag before a genuine -p causes an accepted, harmless duplicate (ideate-core#153 regression surface)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["--verbose", "-p"],
  });
  await complete({ prompt: "x" });
  const argv = spawn.calls[0].args;
  assert.deepEqual(argv, ["--verbose", "-p", "-p", "--output-format", "json"]);
});

// ── Bare-flag / garbage-value invariant hardening ───────────────────────────
test("complete() throws when req.model is a non-string (garbage, not forwarded as-is)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x", model: true }),
    (e) => e instanceof HeadlessCliError && /must be a string/.test(e.message),
  );
  assert.equal(spawn.calls.length, 0, "must throw before ever spawning the CLI");
});

test("complete() throws when req.effort is a non-string object", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x", effort: {} }),
    (e) => e instanceof HeadlessCliError && /must be a string/.test(e.message),
  );
});

test("complete() throws when req.model looks like a flag, instead of letting it swallow --effort", async () => {
  // Regression for the bare-flag hazard: req.model === "--effort" would
  // otherwise emit `--model --effort <value>`, and the real --effort push
  // would then be stripped-and-reappended against the wrong occurrence.
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x", model: "--effort", effort: "high" }),
    (e) => e instanceof HeadlessCliError && /looks like a flag/.test(e.message),
  );
  assert.equal(spawn.calls.length, 0);
});

test("complete() throws when req.effort looks like a flag", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x", effort: "-x" }),
    (e) => e instanceof HeadlessCliError && /looks like a flag/.test(e.message),
  );
});

// ── stripFlagPair near-miss pinning (ideate-core#152 review, finding 3) ─────
// These lock down that only an EXACT flag match (or its `=value` form) is
// ever stripped — a prefix/suffix near-miss must survive untouched.
test("a --models near-miss is preserved when overriding --model", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--models", "keep-me"],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, [
    "-p",
    "--output-format",
    "json",
    "--models",
    "keep-me",
    "--model",
    "opus",
  ]);
});

test("a --model-set near-miss is preserved when overriding --model", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--model-set", "abc"],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, [
    "-p",
    "--output-format",
    "json",
    "--model-set",
    "abc",
    "--model",
    "opus",
  ]);
});

test("an --effortless near-miss is preserved when overriding --effort", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--effortless", "true"],
  });
  await complete({ prompt: "x", effort: "high" });
  assert.deepEqual(spawn.calls[0].args, [
    "-p",
    "--output-format",
    "json",
    "--effortless",
    "true",
    "--effort",
    "high",
  ]);
});

test("a trailing bare --model with no value is stripped safely (no crash, no stray token)", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--model"],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "opus"]);
});

// Regression history (ideate-core#152 review round 3, finding 1): the
// PREVIOUS shape of these two tests put `-p`/`--output-format json` BEFORE
// the trailing bare `--model`/`--effort`, so `stripFlagPair` had nothing to
// consume as the flag's "value" — it passed even when `ensureRequiredFlags`
// ran once at construction and got its injected `-p` eaten by the very
// strip it was supposed to survive.
//
// Superseded (ideate-core#158 review): these two were then rewritten to put
// the bare flag LAST and pass a matching `req.model`/`req.effort`, which
// made `-p` survive — but only because THAT call happened to supply the
// field. `TRAILING_FLAG_SAFE_LIST` treated the shape as unconditionally
// safe on that basis, which is a RUNTIME fact a CONSTRUCTION-time check
// cannot observe: a call to the SAME `complete` that omits `req.model`
// hits the real CLI's behavior — `claude --model` shifts the next token
// (the injected `-p`) as `--model`'s value unconditionally, and
// `claude --effort -p` is worse, only warning and proceeding with no print
// flag, landing in the exact silent `{ok:true, text:"<prose>"}` terminus
// ideate-core#158 exists to close. So a trailing bare `--model`/`--effort`
// is now refused at construction like any other arity-unknown trailing
// flag, regardless of what any individual call's `req` supplies.
test("a caller args array that is ONLY a trailing bare --model is refused at construction (ideate-core#158)", () => {
  assert.throws(
    () => createHeadlessCliComplete({ spawn: makeFakeSpawn(), args: ["--model"] }),
    (e) => e instanceof HeadlessCliError && /does not know the arity of/.test(e.message),
  );
});

test("a caller args array that is ONLY a trailing bare --effort is refused at construction (ideate-core#158)", () => {
  assert.throws(
    () => createHeadlessCliComplete({ spawn: makeFakeSpawn(), args: ["--effort"] }),
    (e) => e instanceof HeadlessCliError && /does not know the arity of/.test(e.message),
  );
});

test("repeated --model occurrences in caller args all collapse to the one forwarded pair", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--model", "foo", "--output-format", "json", "--model", "bar"],
  });
  await complete({ prompt: "x", model: "baz" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "baz"]);
});

test("a --model= with an empty value is stripped by the single-token form", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--model="],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "opus"]);
});

// ── Caller-supplied `options.args` vs. per-agent routing fields ─────────────
// Decision (recorded in the PR body): the per-agent request field WINS. A
// caller-supplied `--model`/`--effort` already present in `options.args` is
// stripped (flag + its value) and replaced by the request field's value, so
// argument-array order never decides the outcome and no duplicate/conflicting
// flag pair is ever sent.
test("a per-agent req.model overrides a --model already present in caller-supplied args", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--model", "haiku"],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "opus"]);
});

test("a per-agent req.effort overrides a --effort already present in caller-supplied args", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--effort", "low", "--output-format", "json"],
  });
  await complete({ prompt: "x", effort: "xhigh" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--effort", "xhigh"]);
});

test("a per-agent req.model overrides a caller-supplied --model=value (single-token) form", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--output-format", "json", "--model=haiku"],
  });
  await complete({ prompt: "x", model: "opus" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "opus"]);
});

test("a per-agent req.effort overrides a caller-supplied --effort=value (single-token) form", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const complete = createHeadlessCliComplete({
    spawn,
    args: ["-p", "--effort=low", "--output-format", "json"],
  });
  await complete({ prompt: "x", effort: "xhigh" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--effort", "xhigh"]);
});

test("caller-supplied args survive untouched when the request has no model/effort", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
  const customArgs = ["-p", "--output-format", "json", "--model", "haiku"];
  const complete = createHeadlessCliComplete({ spawn, args: customArgs });
  await complete({ prompt: "x" });
  assert.deepEqual(spawn.calls[0].args, ["-p", "--output-format", "json", "--model", "haiku"]);
});

// ── Argv arity refusals (ideate-core#158) ───────────────────────────────────
// Decision: refuse the shapes below LOUDLY at construction rather than build
// a flag-arity table for the `claude` CLI (see ideate-core#158 for the full
// reasoning). All three throw synchronously from `createHeadlessCliComplete`
// itself — never per-call — so a bad `options.args` fails immediately
// instead of surfacing as a dropped agent inside the engine's swallow.
test("options.args containing -- (end-of-options) is refused at construction (ideate-core#158, case a)", () => {
  assert.throws(
    () => createHeadlessCliComplete({ spawn: makeFakeSpawn(), args: ["--", "-p"] }),
    (e) => e instanceof HeadlessCliError && /end-of-options/.test(e.message),
  );
});

test("a trailing bare value-taking-looking flag in options.args is refused at construction (ideate-core#158, case b)", () => {
  assert.throws(
    () =>
      createHeadlessCliComplete({
        spawn: makeFakeSpawn(),
        args: ["-p", "--append-system-prompt"],
      }),
    (e) => e instanceof HeadlessCliError && /does not know the arity of/.test(e.message),
  );
});

test("a flag-shaped value in options.args positioned right after --model/--effort is refused at construction (ideate-core#158, case c)", () => {
  assert.throws(
    () =>
      createHeadlessCliComplete({
        spawn: makeFakeSpawn(),
        args: ["--effort", "--model"],
      }),
    (e) => e instanceof HeadlessCliError && /--effort's value/.test(e.message),
  );
});

test("case (c) refusal also fires when --model precedes the flag-shaped token", () => {
  assert.throws(
    () =>
      createHeadlessCliComplete({
        spawn: makeFakeSpawn(),
        args: ["--model", "--effort"],
      }),
    (e) => e instanceof HeadlessCliError && /--model's value/.test(e.message),
  );
});

test("the throw happens at construction, before any spawn — never inside complete()", () => {
  let threw = false;
  try {
    createHeadlessCliComplete({ spawn: makeFakeSpawn(), args: ["--", "-p"] });
  } catch (e) {
    threw = e instanceof HeadlessCliError;
  }
  assert.ok(threw, "expected a synchronous construction-time throw");
});

// Legitimate shapes that must keep working — a refusal that catches any of
// these is a regression, not a fix (ideate-core#158 verification bar).
test("legitimate args shapes are NOT refused at construction (ideate-core#158)", async () => {
  const legitimateShapes = [
    ["-p", "--output-format", "json"],
    ["--model", "haiku"],
    ["--verbose", "-p"],
    ["-p", "--output-format", "text"],
    ["-p", "--output-format=text"],
  ];
  for (const args of legitimateShapes) {
    const spawn = makeFakeSpawn({ stdout: '{"is_error":false,"result":"ok"}', code: 0 });
    assert.doesNotThrow(
      () => createHeadlessCliComplete({ spawn, args }),
      `unexpected refusal for legitimate shape ${JSON.stringify(args)}`,
    );
  }
});

// ── Loud failures ────────────────────────────────────────────────────────────
test("complete() throws (not returns null) when the CLI is missing (ENOENT)", async () => {
  const spawn = makeFakeSpawn({ errorEvent: enoent() });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x" }),
    (e) => e instanceof HeadlessCliError && /not found on PATH/.test(e.message),
  );
});

test("complete() throws on non-zero exit and surfaces stderr", async () => {
  const spawn = makeFakeSpawn({ stderr: "not authenticated", code: 1 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({ prompt: "x" }),
    (e) => /exited with code 1/.test(e.message) && /not authenticated/.test(e.message),
  );
});

test("complete() throws when output has no extractable text", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(complete({ prompt: "x" }), (e) =>
    /could not extract non-empty text/.test(e.message),
  );
});

test("complete() requires a non-empty prompt", async () => {
  const spawn = makeFakeSpawn({ stdout: "x", code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(
    complete({}),
    (e) => e instanceof HeadlessCliError && /req\.prompt/.test(e.message),
  );
});

test("complete() times out and kills a hung CLI", async () => {
  const spawn = makeFakeSpawn({ neverClose: true });
  const complete = createHeadlessCliComplete({ spawn, timeoutMs: 20 });
  await assert.rejects(complete({ prompt: "x" }), (e) => /timed out after 20ms/.test(e.message));
});

// ── assertHeadlessCliAvailable preflight ─────────────────────────────────────
test("assertHeadlessCliAvailable returns the version on success", async () => {
  const spawn = makeFakeSpawn({ stdout: "1.2.3 (Claude Code)\n", code: 0 });
  const res = await assertHeadlessCliAvailable({ spawn });
  assert.deepEqual(res, { ok: true, version: "1.2.3 (Claude Code)" });
  assert.deepEqual(spawn.calls[0].args, ["--version"]);
});

test("assertHeadlessCliAvailable throws loudly when the CLI is absent", async () => {
  const spawn = makeFakeSpawn({ errorEvent: enoent() });
  await assert.rejects(assertHeadlessCliAvailable({ spawn }), (e) =>
    /not found on PATH/.test(e.message),
  );
});

test("assertHeadlessCliAvailable throws when the probe exits non-zero (unauthenticated)", async () => {
  const spawn = makeFakeSpawn({ stderr: "please run `claude` to log in", code: 1 });
  await assert.rejects(assertHeadlessCliAvailable({ spawn }), (e) =>
    /may be installed but not authenticated/.test(e.message),
  );
});

// ── runProcess resolves rather than rejects ──────────────────────────────────
test("runProcess resolves a spawnError envelope on synchronous spawn throw", async () => {
  const spawn = () => {
    throw enoent();
  };
  const env = await runProcess({ command: "claude", spawn });
  assert.equal(env.spawnError.code, "ENOENT");
  assert.equal(env.code, null);
});

// ── Argv invariant, driven through the real engine ──────────────────────────
// ideate-core#152 review, finding 2: this is deliberately NOT a port of
// subagent-dispatch.test.mjs's "forwards every routing field the engine
// sends" drift-pin test. That test earns its keep because `defaultMapRequest`
// forwards an arbitrary object to a host that accepts arbitrary keys, so
// "everything the engine sends must round-trip" is a real correctness
// property there. This adapter maps onto a FIXED, two-flag CLI surface where
// the correct default for any field without a flag is to DROP it — a future
// engine field with no CLI equivalent is correctly absent from the argv, not
// a bug. Porting the pattern here would mean hand-listing every field this
// adapter does NOT forward (already `persona`, `strategy`, `ideasPerAgent`,
// `temperature`, `maxTokens`, `round`) against the two it does — a seven-item
// exclusion set babysitting a two-item forward set, which is exactly the
// "second hand-copied list that drifts in lockstep and catches nothing" that
// subagent-dispatch.test.mjs itself warns against (see its lines ~196-199).
//
// What IS specific to this adapter, and worth pinning, is the shape of the
// argv it hands the CLI — drive the real engine through a fake spawn and
// assert every single emitted argv satisfies the CLI-invocation invariants.
function assertArgvInvariants(argv) {
  assert.ok(argv.includes("-p"), `argv missing -p: ${JSON.stringify(argv)}`);
  const ofIdx = argv.indexOf("--output-format");
  assert.ok(ofIdx !== -1, `argv missing --output-format: ${JSON.stringify(argv)}`);
  assert.equal(
    argv[ofIdx + 1],
    "json",
    `--output-format not immediately followed by json: ${JSON.stringify(argv)}`,
  );

  for (const flag of ["--model", "--effort"]) {
    const occurrences = argv.filter((a) => a === flag).length;
    assert.ok(
      occurrences <= 1,
      `argv has ${occurrences} occurrences of ${flag}: ${JSON.stringify(argv)}`,
    );
    const idx = argv.indexOf(flag);
    if (idx !== -1) {
      const value = argv[idx + 1];
      assert.ok(
        typeof value === "string" && !value.startsWith("--"),
        `${flag} not followed by a value token: ${JSON.stringify(argv)}`,
      );
    }
  }
}

async function driveEngineAndCollectArgv(completeOptions) {
  const spawnedArgs = [];
  const spawn = makeFakeSpawn({
    stdout: JSON.stringify({ is_error: false, result: '[{"text":"idea"}]' }),
    code: 0,
  });
  const recordingSpawn = (...args) => {
    spawnedArgs.push(args[1]); // args[1] is the argv array `spawn(command, args, opts)`
    return spawn(...args);
  };
  const complete = createHeadlessCliComplete({ ...completeOptions, spawn: recordingSpawn });

  await ideateCore(
    { context: { brief: "ways to promote a product launch" } },
    {
      complete,
      buildRound1Prompt: ({ persona }) => `As ${persona}, reply JSON [{"text":"…"}].`,
      buildRound2Prompt: ({ persona }) => `As ${persona}, extend the pool as JSON [{"text":"…"}].`,
      maxRounds: 2,
      agents: [
        { persona: "pragmatist", model: "opus", effort: "low" },
        { persona: "contrarian", model: "sonnet", effort: "xhigh" },
        { persona: "skeptic" }, // no model/effort — absent-stays-absent case, in the mix
      ],
    },
  );

  assert.ok(spawnedArgs.length >= 3, "expected multiple real engine-driven CLI invocations");
  return spawnedArgs;
}

test("every argv the real engine drives through this adapter (default args) satisfies the CLI-invocation invariants", async () => {
  const spawnedArgs = await driveEngineAndCollectArgv({});
  for (const argv of spawnedArgs) assertArgvInvariants(argv);
});

// ideate-core#152 review round 3, finding 2: the test above alone passes
// VACUOUSLY against the -p-gets-eaten regression (finding 1) — with no
// `options.args`, every call walks the DEFAULT_ARGS path where `-p`/
// `--output-format` are already present, so `ensureRequiredFlags` never has
// anything to add and its call site (before vs. after the per-agent
// strip/append) cannot matter. Mutation-checked: gutting `ensureRequiredFlags`
// to `return args` leaves the default-args test above passing. This second
// run forces every request through a caller-supplied `args` that has NEITHER
// required flag AND already occupies the `--model` slot the per-agent
// forwarding will strip and rebuild — the exact path that had the bug — so a
// regression in `ensureRequiredFlags`'s call site, or in the function itself,
// fails THIS test even when the default-args run above is clean.
test("every argv the real engine drives through this adapter (caller args forcing the strip path) satisfies the CLI-invocation invariants", async () => {
  const spawnedArgs = await driveEngineAndCollectArgv({ args: ["--model", "placeholder"] });
  for (const argv of spawnedArgs) assertArgvInvariants(argv);
});

// ── End-to-end through ideateCore ────────────────────────────────────────────
test("ideateCore drives candidates through the headless-CLI adapter", async () => {
  // Every agent's `complete` gets the same scripted JSON array of ideas.
  const spawn = makeFakeSpawn({
    stdout: JSON.stringify({
      is_error: false,
      result: '[{"text":"shared idea A"},{"text":"shared idea B"}]',
    }),
    code: 0,
  });
  const complete = createHeadlessCliComplete({ spawn });
  const buildRound1Prompt = ({ context, stance }) =>
    `${stance}\nBrief: ${context.brief}\nReply JSON [{"text":"…"}].`;

  const { candidates } = await ideateCore(
    { context: { slug: "demo", brief: "promote a launch" } },
    { complete, buildRound1Prompt, agentCount: 3, maxRounds: 1 },
  );
  // Dedup collapses the identical ideas across agents to the 2 distinct texts.
  const texts = candidates.map((c) => c.text).sort();
  assert.deepEqual(texts, ["shared idea A", "shared idea B"]);
  assert.ok(candidates.every((c) => c.origin === "generated"));
});
