// Tests for feedback.mjs (S4, #6). Fully offline — the evaluator, generator
// client, and regen-prompt builder are injected mocks. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    complete: async (req) => ({
      ok: true,
      text: JSON.stringify([{ text: "Idea B, now cheaper" }]),
    }),
    evaluate: async (p, ctx) => {
      if (ctx.round === 1) {
        return {
          verdicts: [
            { ideaId: "a", decision: "keep" },
            {
              ideaId: "b",
              decision: "revise",
              dealKillers: ["too costly"],
              keepReasons: ["good hook"],
            },
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

test("regeneration honors deps.maxTokens and the agent's numeric temperature, never the persona label (ideate-core#92)", async () => {
  const seen = [];
  const complete = async (req) => {
    seen.push({ maxTokens: req.maxTokens, temperature: req.temperature, regen: req.regen });
    return { ok: true, text: JSON.stringify([{ text: "revised" }]) };
  };
  // A candidate produced by the default 'pragmatist' agent (temperature 0.4).
  // Its own `temperature` field is the persona LABEL, which must never be sent.
  const pool = [
    {
      id: "pragmatist-r1-1",
      text: "orig",
      persona: "pragmatist",
      agentId: "pragmatist",
      temperature: "pragmatist", // the label — must NOT reach the regen call
      round: 1,
      origin: "generated",
    },
  ];
  await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    maxTokens: 512,
    complete,
    evaluate: async () => ({
      verdicts: [{ ideaId: "pragmatist-r1-1", decision: "revise", dealKillers: ["x"] }],
    }),
    buildRegenPrompt: () => "REGEN",
  });
  const regen = seen.find((s) => s.regen);
  assert.ok(regen, "a regen call happened");
  assert.equal(regen.maxTokens, 512, "regen honors deps.maxTokens (was hardcoded 2048)");
  assert.equal(
    regen.temperature,
    0.4,
    "regen uses the pragmatist agent's numeric temperature (was flat 0.7)",
  );
  assert.equal(typeof regen.temperature, "number", "never the persona-label string");
});

test("regeneration falls back to 0.7 / 2048 when the agent can't be resolved (ideate-core#92)", async () => {
  const seen = [];
  const complete = async (req) => {
    seen.push({ maxTokens: req.maxTokens, temperature: req.temperature, regen: req.regen });
    return { ok: true, text: JSON.stringify([{ text: "revised" }]) };
  };
  // No agentId → not resolvable → previous defaults retained.
  const pool = [cand("a", "orig")];
  await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    complete,
    evaluate: async () => ({ verdicts: [{ ideaId: "a", decision: "revise", dealKillers: ["x"] }] }),
    buildRegenPrompt: () => "REGEN",
  });
  const regen = seen.find((s) => s.regen);
  assert.equal(regen.temperature, 0.7);
  assert.equal(regen.maxTokens, 2048);
});

test("a broken evaluator is observable (evaluatorFailures), not read as satisfied (ideate-core#90)", async () => {
  const pool = [cand("a", "A"), cand("b", "B")];
  const errors = [];
  const { candidates, feedback } = await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 2 },
    complete: async () => ({ ok: true, text: "[]" }),
    evaluate: async () => {
      throw new Error("evaluator 500");
    },
    buildRegenPrompt: () => "REGEN",
    onEvaluatorError: (err, ctx) => errors.push({ err, ctx }),
  });
  // Robustness: the pool passes through untouched, nothing thrown.
  assert.equal(candidates.length, 2);
  // ...but the thrown evaluator is now distinguishable from a satisfied one.
  assert.equal(feedback.evaluatorFailures, 1);
  assert.equal(feedback.rounds, 0, "a throwing evaluator produced no completed round");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ctx.round, 1);
});

test("a healthy evaluator reports zero evaluatorFailures (ideate-core#90)", async () => {
  const pool = [cand("a", "A")];
  const { feedback } = await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    complete: async () => ({ ok: true, text: "[]" }),
    evaluate: async () => ({ verdicts: [{ ideaId: "a", decision: "keep" }] }),
    buildRegenPrompt: () => "REGEN",
  });
  assert.equal(feedback.evaluatorFailures, 0);
});

test("regeneration runs concurrently and preserves output order (ideate-core#98)", async () => {
  let active = 0;
  let maxActive = 0;
  const complete = async (req) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { ok: true, text: JSON.stringify([{ text: `revised ${req.prompt}` }]) };
  };
  const pool = [cand("a", "A"), cand("b", "B"), cand("c", "C")];
  const { candidates } = await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    complete,
    evaluate: async () => ({
      verdicts: [
        { ideaId: "a", decision: "revise", dealKillers: [] },
        { ideaId: "b", decision: "revise", dealKillers: [] },
        { ideaId: "c", decision: "revise", dealKillers: [] },
      ],
    }),
    buildRegenPrompt: ({ original }) => `REGEN ${original.id}`,
  });
  assert.ok(maxActive >= 2, "regenerations must overlap (were concurrent), not run one at a time");
  // Output order is stable: a, b, c revised in place.
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["a-rev1", "b-rev1", "c-rev1"],
  );
});

test("regenConcurrency caps in-flight regens while preserving order (ideate-core#98)", async () => {
  let active = 0;
  let maxActive = 0;
  const complete = async (req) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { ok: true, text: JSON.stringify([{ text: `rev ${req.prompt}` }]) };
  };
  const pool = ["a", "b", "c", "d"].map((id) => cand(id, id.toUpperCase()));
  const { candidates } = await runFeedbackLoop(pool, {
    feedbackLoop: { maxRegenRounds: 1 },
    regenConcurrency: 2,
    complete,
    evaluate: async () => ({
      verdicts: pool.map((c) => ({ ideaId: c.id, decision: "revise", dealKillers: [] })),
    }),
    buildRegenPrompt: ({ original }) => `REGEN ${original.id}`,
  });
  assert.ok(maxActive <= 2, `at most 2 concurrent regens, saw ${maxActive}`);
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["a-rev1", "b-rev1", "c-rev1", "d-rev1"],
  );
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
      buildRegenPrompt: ({ original, dealKillers }) =>
        `REGEN ${original.id} kills=${dealKillers.join(",")}`,
    },
  );
  assert.ok(meta.feedbackRounds >= 1);
  assert.ok(feedback.rounds >= 1);
  assert.ok(
    candidates.some((c) => c.text === "Revised idea"),
    "flagged idea was regenerated",
  );
});

// ── Drift guard: the loop does not cluster, and cannot (ideate-core#140) ─────
//
// docs/ideation-method.md once described this loop as ending in a "re-cluster".
// It never did, and the ordering makes the "re-" impossible: runFeedbackLoop is
// called BEFORE convergePool, so at feedback time no clustering has happened at
// all. These two tests pin that PIPELINE SHAPE rather than today's wording, so
// the absent behaviour cannot be added silently, and the claim cannot be
// restated as true without a code change that trips the guard.

// The clustering entry point, held as data so the assertions below read it the
// same way a caller would spell it.
const CLUSTER_ENTRY_POINT = "clusterByEmbedding";

// A real comment/string stripper, not a line-prefix heuristic: an identifier
// that only ever appears inside a comment or a string literal is a MENTION, not
// a call, and must not trip the guard. Handles line and block comments, single-
// and double-quoted strings, and template literals — including `${...}`
// interpolations, whose contents are live code and stay in the output.
function stripCommentsAndStrings(src) {
  const out = [];
  const modes = ["code"]; // innermost first: "code" | "template"
  const braces = []; // brace depth inside each open `${ ... }`
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (modes[modes.length - 1] === "template") {
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        modes.pop();
        out.push(" ");
        i += 1;
      } else if (c === "$" && d === "{") {
        modes.push("code");
        braces.push(0);
        out.push(" ");
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      out.push(" ");
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(" ");
      continue;
    }
    if (c === "`") {
      modes.push("template");
      out.push(" ");
      i += 1;
      continue;
    }
    if (braces.length) {
      if (c === "{") braces[braces.length - 1] += 1;
      else if (c === "}") {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          modes.pop();
          out.push(" ");
          i += 1;
          continue;
        }
        braces[braces.length - 1] -= 1;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

const callsClusterEntryPoint = (src) =>
  new RegExp(`\\b${CLUSTER_ENTRY_POINT}\\b`).test(stripCommentsAndStrings(src));

test("the feedback module never calls the clustering entry point (ideate-core#140)", async () => {
  const src = await readFile(new URL("./feedback.mjs", import.meta.url), "utf8");

  // Positive control: a clean verdict below must mean "absent", not "the scan
  // ate the file". Both of these are real, live identifiers in feedback.mjs.
  const stripped = stripCommentsAndStrings(src);
  assert.match(stripped, /\bdedupeById\b/, "stripper dropped live code");
  assert.match(stripped, /\brunFeedbackLoop\b/, "stripper dropped live code");

  assert.ok(
    !callsClusterEntryPoint(src),
    `${CLUSTER_ENTRY_POINT} must have no caller in feedback.mjs: the loop runs before ` +
      "convergePool, so there is nothing to cluster or re-cluster here",
  );

  // The counter-example the guard is worth having: a feedback.mjs that DOES
  // call the clustering entry point must trip the same check. Without this, a
  // guard that silently matched nothing would pass forever.
  const anchor = "pool = dedupeById([...kept, ...regenerated]);";
  assert.ok(src.includes(anchor), "counter-example anchor moved; update this test");
  const mutated = src.replace(
    anchor,
    `pool = ${CLUSTER_ENTRY_POINT}(dedupeById([...kept, ...regenerated]));`,
  );
  assert.ok(
    callsClusterEntryPoint(mutated),
    "the guard must reject a feedback.mjs that calls the clustering entry point",
  );

  // ...and a mere MENTION in prose must not, or the guard would pin wording
  // instead of shape.
  assert.ok(
    !callsClusterEntryPoint(`// this module never calls ${CLUSTER_ENTRY_POINT}\nconst a = 1;\n`),
    "a comment mentioning the entry point must not count as a call",
  );
});

test("the feedback loop runs before convergence, so nothing precedes it to re-cluster (ideate-core#140)", async () => {
  const src = stripCommentsAndStrings(
    await readFile(new URL("./ideate-core.mjs", import.meta.url), "utf8"),
  );
  const feedbackAt = src.indexOf("runFeedbackLoop(");
  const convergeAt = src.indexOf("convergePool(");
  assert.ok(feedbackAt > -1, "runFeedbackLoop must be called from ideate-core.mjs");
  assert.ok(convergeAt > -1, "convergePool must be called from ideate-core.mjs");
  assert.ok(
    feedbackAt < convergeAt,
    "runFeedbackLoop must run BEFORE convergePool — the docs' description of the " +
      "loop depends on no clustering having happened yet",
  );
});
