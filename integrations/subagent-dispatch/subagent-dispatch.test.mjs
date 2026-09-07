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
  defaultMapRequest,
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
  await assert.rejects(
    () => complete({ persona: "x" }),
    /req\.prompt \(non-empty string\) is required/,
  );
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
  await assert.rejects(
    () => complete({ prompt: "p", persona: "Ada" }),
    (err) => {
      assert.ok(err instanceof SubagentDispatchError);
      assert.match(err.message, /persona 'Ada' failed/);
      assert.match(err.message, /runtime exploded/);
      return true;
    },
  );
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
  await assert.rejects(
    () => complete({ prompt: "p", persona: "x" }),
    /could not extract reply text/,
  );
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

// ── defaultMapRequest: pin the forwarding contract against the real engine ──
//
// The allowlist in defaultMapRequest has no coupling to lib/ideate-core.mjs's
// request shape, so it can silently drop a future pass-through field exactly
// like it silently dropped `effort` (ideate-core#149). Instead of asserting against a
// second hand-copied field list here (which would drift in lockstep with the
// implementation and catch nothing), this test runs the REAL engine with a
// recording `complete` to capture what it actually puts on the request, then
// checks defaultMapRequest forwards every one of those fields unchanged. If
// the engine grows a new pass-through field, this test starts failing the
// moment defaultMapRequest doesn't also grow to cover it — no test edit
// required to detect the drift, only to fix it.
test("defaultMapRequest forwards every routing field the engine actually sends, with no hand-copied list", async () => {
  const engineRequests = [];
  const recordingComplete = async (req) => {
    engineRequests.push(req);
    return { ok: true, text: ideasReply(req) };
  };

  await ideateCore(
    { context: { brief: "ways to promote a product launch" } },
    {
      complete: recordingComplete,
      buildRound1Prompt: ({ persona }) => `As ${persona}, produce ideas as a JSON array of {text}.`,
      // A build-on round-2 prompt so round 2 actually fires — that's the call
      // site (lib/ideate-core.mjs ~line 313) this bug lived in, and it also
      // adds the `round` field to the request, which the exclusion set below
      // has to name explicitly rather than just never seeing it.
      buildRound2Prompt: ({ persona }) =>
        `As ${persona}, extend the pool as a JSON array of {text}.`,
      maxRounds: 2,
      // Every agent field set to a distinct, non-default value so the request
      // is maximally dense — an `undefined === undefined` comparison would
      // pass vacuously and hide a real drop, the way `effort` was hidden
      // before ideate-core#149 (it only survived as a *key* because resolveAgents always
      // writes it, even unset; a conditionally-added future field would not
      // even show up as a key under a sparser agent spec).
      agents: [
        {
          persona: "pragmatist",
          strategy: "direct",
          model: "test-model-a",
          temperature: 0.3,
          ideasPerAgent: 4,
          effort: "low",
        },
        {
          persona: "contrarian",
          strategy: "cot",
          model: "test-model-b",
          temperature: 0.9,
          ideasPerAgent: 5,
          effort: "high",
        },
      ],
    },
  );

  // Round 1 (2 agents) + round 2 (2 agents, pool non-empty) = 4 requests.
  assert.ok(
    engineRequests.length >= 3,
    "expected both round 1 and round 2 requests to be recorded",
  );
  assert.ok(
    engineRequests.some((r) => r.round === 2),
    "expected at least one round-2 request — buildRound2Prompt should have fired",
  );

  // Deliberately NOT forwarded to a subagent dispatch: these are library-
  // internal/transport parameters (a token budget, a round counter), not
  // persona-routing fields a dispatch target consumes. This exclusion set is
  // the one place a reviewer needs to touch if a future field is intentionally
  // kept off the wire — everything else must round-trip in both directions.
  const NOT_ROUTING_FIELDS = new Set(["maxTokens", "round"]);

  for (const req of engineRequests) {
    const mapped = defaultMapRequest(req);

    // Forward direction: every routing field the engine sent must survive,
    // unchanged, into the mapped task.
    for (const key of Object.keys(req)) {
      if (NOT_ROUTING_FIELDS.has(key)) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(mapped, key),
        `defaultMapRequest dropped engine request field "${key}" — the engine sends it but the adapter's allowlist doesn't forward it. If this is a routing field, add it to defaultMapRequest's return; if it's a transport/library-internal field (like maxTokens), add it to NOT_ROUTING_FIELDS above instead of forwarding it to the host's dispatch primitive.`,
      );
      assert.equal(
        mapped[key],
        req[key],
        `defaultMapRequest changed the value of forwarded field "${key}"`,
      );
    }

    // Reverse direction: every mapped field must trace back to a value the
    // engine actually set on `req` (not a value defaultMapRequest invented).
    // Every key here is read as `req.X`, so an engine field that's merely
    // absent is already `undefined` and skipped below — this loop doesn't
    // catch "the engine stopped sending a field the adapter still lists"
    // (the forward loop above only iterates keys present on `req`, so it
    // can't catch that either; nothing in this test does). What this DOES
    // catch: defaultMapRequest injecting a computed value the engine never
    // provided, e.g. `effort: req.effort ?? "medium"` — a default baked into
    // the adapter that the engine's request shape doesn't actually justify.
    for (const key of Object.keys(mapped)) {
      if (mapped[key] === undefined) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(req, key),
        `defaultMapRequest forwarded "${key}" but the engine's request never set it`,
      );
    }
  }
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
