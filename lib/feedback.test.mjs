// Tests for feedback.mjs (S4, #6). Fully offline — the evaluator, generator
// client, and regen-prompt builder are injected mocks. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFeedback,
  exampleAdapterFromPanelist,
  assertEvaluatorDistinct,
  runFeedbackLoop,
  DEFAULT_MAX_REGEN_ROUNDS,
} from "./feedback.mjs";
import { ideateCore } from "./ideate-core.mjs";

const cand = (id, text, extra = {}) => ({
  id,
  text,
  model: extra.model,
  persona: extra.persona || "pragmatist",
  round: 1,
  origin: "generated",
  ...extra,
});

test("normalizeFeedback coerces decision synonyms, drops verdicts without ideaId (S4)", () => {
  const fb = normalizeFeedback({
    verdicts: [
      { ideaId: "a", decision: "PASS" },
      { ideaId: "b", verdict: "drop", dealKillers: ["x"] },
      { decision: "revise" }, // no ideaId → dropped
      { ideaId: "c", decision: "weird-word" }, // unknown → safe default keep
    ],
    poolDirectives: ["go bolder"],
  });
  assert.equal(fb.verdicts.length, 3);
  assert.equal(fb.verdicts[0].decision, "keep");
  assert.equal(fb.verdicts[1].decision, "kill");
  assert.deepEqual(fb.verdicts[1].dealKillers, ["x"]);
  assert.equal(fb.verdicts[2].decision, "keep");
  assert.deepEqual(fb.poolDirectives, ["go bolder"]);
  assert.equal(fb.verdicts[0].scores.novelty, null); // split axes present, unknown=null
  assert.equal(fb.verdicts[0].scores.feasibility, null);
});

test("exampleAdapterFromPanelist maps panelist's {verdict,message,dealKillers} onto the contract (S4)", () => {
  const fb = exampleAdapterFromPanelist(
    [
      { ideaId: "a", verdict: "revise", message: "sharpen the hook", dealKillers: ["too broad"] },
      { ideaId: "b", verdict: "kill", dealKillers: ["off-brand"] },
    ],
    ["raise the bar"],
  );
  assert.equal(fb.verdicts[0].decision, "revise");
  assert.deepEqual(fb.verdicts[0].keepReasons, ["sharpen the hook"]);
  assert.deepEqual(fb.verdicts[0].dealKillers, ["too broad"]);
  assert.equal(fb.verdicts[1].decision, "kill");
  assert.deepEqual(fb.poolDirectives, ["raise the bar"]);
});

test("assertEvaluatorDistinct throws when evaluator shares a generator model (S4)", () => {
  assert.throws(
    () =>
      assertEvaluatorDistinct(
        { evaluator: { model: "m1" } },
        { agents: [{ persona: "pragmatist", model: "m1" }] },
      ),
    /must DIFFER/,
  );
  // undeclared evaluator model ⇒ treated distinct (caller's responsibility)
  assert.equal(assertEvaluatorDistinct({ evaluator: {} }, {}), true);
  // declared but distinct
  assert.equal(
    assertEvaluatorDistinct({ evaluator: { model: "judge" } }, { agents: [{ model: "gen" }] }),
    true,
  );
});

test("runFeedbackLoop: revise regenerates against feedback, kill drops, keep passes (S4)", async () => {
  const pool = [cand("a", "Idea A"), cand("b", "Idea B"), cand("c", "Idea C")];
  const seenRegen = [];
  const deps = {
    feedbackLoop: { maxRegenRounds: 2, targeting: "per-idea", evaluator: { model: "judge-x" } },
    complete: async (req) => ({ ok: true, text: JSON.stringify([{ text: "Idea B, now cheaper" }]) }),
    evaluate: async (p, ctx) => {
      if (ctx.round === 1) {
        return {
          verdicts: [
            { ideaId: "a", decision: "keep" },
            { ideaId: "b", decision: "revise", dealKillers: ["too costly"], keepReasons: ["good hook"] },
            { ideaId: "c", decision: "kill" },
          ],
          poolDirectives: ["lean harder into virality"],
        };
      }
      return { verdicts: [] }; // converged
    },
    buildRegenPrompt: (args) => {
      seenRegen.push(args);
      return `REGEN ${args.original.id}`;
    },
  };
  const { candidates, feedback } = await runFeedbackLoop(pool, deps, { context: { slug: "demo" } });
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("a")); // keep passes through
  assert.ok(!ids.includes("c")); // kill drops
  assert.ok(!ids.includes("b")); // revise replaces the original
  const revised = candidates.find((c) => c.id === "b-rev1");
  assert.ok(revised, "revised candidate present");
  assert.equal(revised.text, "Idea B, now cheaper");
  assert.equal(revised.revisedFrom, "b");
  // the targeted regeneration was conditioned on the specific critique
  assert.deepEqual(seenRegen[0].dealKillers, ["too costly"]);
  assert.deepEqual(seenRegen[0].keepReasons, ["good hook"]);
  assert.deepEqual(seenRegen[0].poolDirectives, ["lean harder into virality"]);
  assert.equal(feedback.history[0].revised, 1);
  assert.equal(feedback.history[0].killed, 1);
});

test("runFeedbackLoop is a no-op without feedbackLoop config; default maxRegenRounds is 2 (S4)", async () => {
  const pool = [cand("a", "A")];
  const { candidates, feedback } = await runFeedbackLoop(pool, {});
  assert.equal(candidates.length, 1);
  assert.equal(feedback.rounds, 0);
  assert.equal(DEFAULT_MAX_REGEN_ROUNDS, 2);
});

test("runFeedbackLoop keeps the original when regeneration fails (never loses a flagged idea) (S4)", async () => {
  const pool = [cand("a", "Idea A")];
  const { candidates } = await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    complete: async () => ({ ok: false }), // regen fails
    evaluate: async () => ({ verdicts: [{ ideaId: "a", decision: "revise", dealKillers: ["x"] }] }),
    buildRegenPrompt: () => "REGEN a",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "a"); // original retained
});

test("ideateCore feedbackLoop path vets the pool then converges (S4 integration)", async () => {
  const complete = async (req) => {
    if (req.regen) return { ok: true, text: JSON.stringify([{ text: "Revised idea" }]) };
    if (/^BUILDON/.test(req.prompt)) return { ok: true, text: "[]" };
    return { ok: true, text: JSON.stringify([{ text: `idea ${req.persona}` }]) };
  };
  const evaluate = async (pool, ctx) => {
    if (ctx.round > 1) return { verdicts: [] };
    return { verdicts: [{ ideaId: pool[0].id, decision: "revise", dealKillers: ["meh"] }] };
  };
  const { candidates, feedback, meta } = await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: ({ persona }) => `R1 ${persona}`,
      buildRound2Prompt: () => "BUILDON",
      complete,
      feedbackLoop: { maxRegenRounds: 2, evaluator: { model: "judge-x" } },
      evaluate,
      buildRegenPrompt: ({ original, dealKillers }) => `REGEN ${original.id} kills=${dealKillers.join(",")}`,
    },
  );
  assert.ok(meta.feedbackRounds >= 1);
  assert.ok(feedback.rounds >= 1);
  assert.ok(candidates.some((c) => c.text === "Revised idea"), "flagged idea was regenerated");
});
