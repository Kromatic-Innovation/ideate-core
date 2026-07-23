// Tests for the subagent-dispatch adapter. Fully hermetic: the host's dispatch
// primitive is injected with a scripted fake, so no real agent runtime, Task
// dispatch, or network is touched. Run by the root `node --test` (recursive
// discovery).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSubagentDispatchComplete,
  assertSubagentDispatchAvailable,
  normalizeDispatchText,
  SubagentDispatchError,
} from "./index.mjs";
import { ideateCore } from "../../lib/ideate-core.mjs";

// ── Fake dispatch ────────────────────────────────────────────────────────────
// Records every task it was handed and returns whatever `reply(task)` yields.
function makeFakeDispatch(reply) {
  const calls = [];
  const dispatch = async (task) => {
    calls.push(task);
    return typeof reply === "function" ? reply(task) : reply;
  };
  dispatch.calls = calls;
  return dispatch;
}

// A JSON array of ideas — the shape buildRound1Prompt asks agents to return.
const ideasReply = (task) =>
  JSON.stringify([
    { text: `${task.persona ?? "anon"}: idea one` },
    { text: `${task.persona ?? "anon"}: idea two` },
  ]);

// ── createSubagentDispatchComplete: construction is loud ─────────────────────

test("createSubagentDispatchComplete throws loudly when no dispatch is wired", () => {
  assert.throws(() => createSubagentDispatchComplete(), SubagentDispatchError);
  assert.throws(() => createSubagentDispatchComplete({ dispatch: null }), SubagentDispatchError);
  assert.throws(
    () => createSubagentDispatchComplete({ dispatch: "not-a-fn" }),
    /options\.dispatch \(function\) is required/,
  );
});

// ── complete(): happy path forwards to dispatch, returns {ok,text} ───────────

test("complete forwards the persona request to dispatch and returns {ok,text}", async () => {
  const dispatch = makeFakeDispatch(ideasReply);
  const complete = createSubagentDispatchComplete({ dispatch });

  const res = await complete({
    prompt: "generate ideas",
    persona: "The Contrarian",
    strategy: "subvert",
    model: "m1",
    temperature: 0.9,
    ideasPerAgent: 2,
  });

  assert.equal(res.ok, true);
  assert.match(res.text, /The Contrarian: idea one/);
  // The task handed to dispatch carries the persona routing fields.
  assert.equal(dispatch.calls.length, 1);
  assert.equal(dispatch.calls[0].persona, "The Contrarian");
  assert.equal(dispatch.calls[0].strategy, "subvert");
  assert.equal(dispatch.calls[0].prompt, "generate ideas");
});

test("complete accepts string, {text}, {result}, {output} dispatch shapes", async () => {
  for (const shape of [
    () => "bare string reply",
    () => ({ text: "text-field reply" }),
    () => ({ result: "result-field reply" }),
    () => ({ output: "output-field reply" }),
  ]) {
    const complete = createSubagentDispatchComplete({ dispatch: makeFakeDispatch(shape) });
    const res = await complete({ prompt: "p", persona: "x" });
    assert.equal(res.ok, true);
    assert.ok(res.text.length > 0);
  }
});

test("complete requires a non-empty prompt", async () => {
  const complete = createSubagentDispatchComplete({ dispatch: makeFakeDispatch(ideasReply) });
  await assert.rejects(() => complete({ persona: "x" }), /req\.prompt \(non-empty string\) is required/);
});

test("complete supports a custom mapRequest", async () => {
  const dispatch = makeFakeDispatch(() => "ok");
  const complete = createSubagentDispatchComplete({
    dispatch,
    mapRequest: (req) => ({ agentPrompt: req.prompt, who: req.persona }),
  });
  await complete({ prompt: "p", persona: "Nova" });
  assert.deepEqual(dispatch.calls[0], { agentPrompt: "p", who: "Nova" });
});

// ── complete(): loud failures (never a silent empty pool) ────────────────────

test("complete throws when dispatch throws", async () => {
  const dispatch = async () => {
    throw new Error("runtime exploded");
  };
  const complete = createSubagentDispatchComplete({ dispatch });
  await assert.rejects(() => complete({ prompt: "p", persona: "Ada" }), (err) => {
    assert.ok(err instanceof SubagentDispatchError);
    assert.match(err.message, /persona 'Ada' failed/);
    assert.match(err.message, /runtime exploded/);
    return true;
  });
});

test("complete throws when dispatch returns ok:false", async () => {
  const complete = createSubagentDispatchComplete({
    dispatch: makeFakeDispatch(() => ({ ok: false, error: "no capacity" })),
  });
  await assert.rejects(() => complete({ prompt: "p", persona: "x" }), /ok:false — no capacity/);
});

test("complete throws when dispatch returns an unextractable shape", async () => {
  const complete = createSubagentDispatchComplete({
    dispatch: makeFakeDispatch(() => ({ nope: 1 })),
  });
  await assert.rejects(() => complete({ prompt: "p", persona: "x" }), /could not extract reply text/);
});

test("complete throws when dispatch returns empty text", async () => {
  const complete = createSubagentDispatchComplete({ dispatch: makeFakeDispatch(() => "") });
  await assert.rejects(() => complete({ prompt: "p", persona: "x" }), /produced empty text/);
});

test("complete enforces a dispatch timeout", async () => {
  const dispatch = () => new Promise(() => {}); // never resolves
  const complete = createSubagentDispatchComplete({ dispatch, timeoutMs: 20 });
  await assert.rejects(() => complete({ prompt: "p", persona: "Slow" }), /timed out after 20ms/);
});

// ── normalizeDispatchText unit coverage ──────────────────────────────────────

test("normalizeDispatchText handles the tolerated shapes and rejects the rest", () => {
  assert.equal(normalizeDispatchText("hi"), "hi");
  assert.equal(normalizeDispatchText({ text: "t" }), "t");
  assert.equal(normalizeDispatchText({ result: "r" }), "r");
  assert.equal(normalizeDispatchText({ output: "o" }), "o");
  assert.throws(() => normalizeDispatchText({ ok: false, error: "x" }), SubagentDispatchError);
  assert.throws(() => normalizeDispatchText(42), SubagentDispatchError);
  assert.throws(() => normalizeDispatchText(null), SubagentDispatchError);
});

// ── assertSubagentDispatchAvailable preflight ────────────────────────────────

test("assertSubagentDispatchAvailable throws loudly with no dispatch capability", async () => {
  await assert.rejects(
    () => assertSubagentDispatchAvailable({}),
    /no subagent-dispatch capability available/,
  );
});

test("assertSubagentDispatchAvailable passes a capability check without probing", async () => {
  const res = await assertSubagentDispatchAvailable({ dispatch: makeFakeDispatch(ideasReply) });
  assert.deepEqual(res, { ok: true, probed: false });
});

test("assertSubagentDispatchAvailable can actively probe the dispatch", async () => {
  const good = await assertSubagentDispatchAvailable({
    dispatch: makeFakeDispatch(() => "pong"),
    probe: true,
  });
  assert.deepEqual(good, { ok: true, probed: true });

  await assert.rejects(
    () =>
      assertSubagentDispatchAvailable({
        dispatch: async () => {
          throw new Error("down");
        },
        probe: true,
      }),
    /preflight dispatch failed/,
  );
});

// ── End-to-end through the real engine ───────────────────────────────────────

test("ideateCore drives candidates through the subagent-dispatch adapter", async () => {
  const dispatch = makeFakeDispatch(ideasReply);
  const complete = createSubagentDispatchComplete({ dispatch });

  const { candidates } = await ideateCore(
    { context: { brief: "ways to promote a product launch" } },
    {
      complete,
      buildRound1Prompt: ({ persona }) => `As ${persona}, produce ideas as a JSON array of {text}.`,
      agentCount: 3,
      maxRounds: 1,
    },
  );

  // One dispatch per persona agent (round-1 blind independence).
  assert.equal(dispatch.calls.length, 3);
  assert.ok(candidates.length > 0, "expected a non-empty candidate pool");
  // Every dispatch got a distinct persona woven into its prompt.
  const personas = new Set(dispatch.calls.map((c) => c.persona));
  assert.equal(personas.size, 3, "each agent dispatched under a distinct persona");
});
