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
  assert.equal(
    defaultExtractText('{"type":"result","is_error":false,"result":"hello"}'),
    "hello",
  );
});

test("defaultExtractText falls back to `text`, then raw non-JSON body", () => {
  assert.equal(defaultExtractText('{"text":"via text field"}'), "via text field");
  assert.equal(defaultExtractText("just plain text output"), "just plain text output");
  assert.equal(defaultExtractText("   "), "");
});

test("defaultExtractText throws loudly on is_error=true", () => {
  assert.throws(
    () => defaultExtractText('{"is_error":true,"result":"auth failed"}'),
    (e) => e instanceof HeadlessCliError && /is_error=true/.test(e.message) && /auth failed/.test(e.message),
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

// ── Loud failures ────────────────────────────────────────────────────────────
test("complete() throws (not returns null) when the CLI is missing (ENOENT)", async () => {
  const spawn = makeFakeSpawn({ errorEvent: enoent() });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(complete({ prompt: "x" }), (e) => e instanceof HeadlessCliError && /not found on PATH/.test(e.message));
});

test("complete() throws on non-zero exit and surfaces stderr", async () => {
  const spawn = makeFakeSpawn({ stderr: "not authenticated", code: 1 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(complete({ prompt: "x" }), (e) => /exited with code 1/.test(e.message) && /not authenticated/.test(e.message));
});

test("complete() throws when output has no extractable text", async () => {
  const spawn = makeFakeSpawn({ stdout: '{"is_error":false}', code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(complete({ prompt: "x" }), (e) => /could not extract non-empty text/.test(e.message));
});

test("complete() requires a non-empty prompt", async () => {
  const spawn = makeFakeSpawn({ stdout: "x", code: 0 });
  const complete = createHeadlessCliComplete({ spawn });
  await assert.rejects(complete({}), (e) => e instanceof HeadlessCliError && /req\.prompt/.test(e.message));
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
  await assert.rejects(assertHeadlessCliAvailable({ spawn }), (e) => /not found on PATH/.test(e.message));
});

test("assertHeadlessCliAvailable throws when the probe exits non-zero (unauthenticated)", async () => {
  const spawn = makeFakeSpawn({ stderr: "please run `claude` to log in", code: 1 });
  await assert.rejects(assertHeadlessCliAvailable({ spawn }), (e) => /may be installed but not authenticated/.test(e.message));
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
