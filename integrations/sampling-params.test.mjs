// Tests for the adapter-side sampling-param strip-and-warn (integrations/
// sampling-params.mjs). Fully offline — a mock transport stands in for a
// frontier model that returns HTTP 400 on temperature/top_p/top_k.
// Run by the root `node --test` (recursive discovery).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withSamplingParamStrip,
  modelAcceptsSamplingParams,
  STRIPPABLE_SAMPLING_PARAMS,
} from "./sampling-params.mjs";
import { ideateCore } from "../lib/ideate-core.mjs";

// A mock transport that THROWS if it is handed any sampling param — modelling a
// frontier model's HTTP 400 on temperature/top_p/top_k.
function strictModelComplete() {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    for (const p of STRIPPABLE_SAMPLING_PARAMS) {
      if (req[p] !== undefined && req[p] !== null) {
        throw new Error(`HTTP 400: model does not support '${p}'`);
      }
    }
    return { ok: true, text: JSON.stringify([{ text: `idea for ${req.persona || "?"}` }]) };
  };
  fn.calls = calls;
  return fn;
}

test("modelAcceptsSamplingParams: frontier tiers reject, Haiku accepts, unknown accepts", () => {
  for (const m of ["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
    assert.equal(modelAcceptsSamplingParams(m), false, `${m} should reject`);
  }
  assert.equal(modelAcceptsSamplingParams("claude-haiku-4-5"), true);
  assert.equal(modelAcceptsSamplingParams("gpt-4o"), true); // unknown ⇒ accepts
  assert.equal(modelAcceptsSamplingParams(undefined), true);
  assert.equal(modelAcceptsSamplingParams(""), true);
});

test("a temperature-rejecting model succeeds through the strip, temperature removed", async () => {
  const inner = strictModelComplete();
  const warnings = [];
  const complete = withSamplingParamStrip(inner, { warn: (m) => warnings.push(m) });
  const res = await complete({
    prompt: "p",
    model: "claude-opus-4-8",
    temperature: 0.9,
    persona: "pragmatist",
  });
  assert.equal(res.ok, true, "must not throw / must produce a reply");
  assert.equal(inner.calls[0].temperature, undefined, "temperature stripped before the call");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claude-opus-4-8/);
  assert.match(warnings[0], /temperature/);
});

test("the strip does not mutate the caller's request object", async () => {
  const inner = strictModelComplete();
  const complete = withSamplingParamStrip(inner, { warn: () => {} });
  const req = { prompt: "p", model: "claude-sonnet-5", temperature: 0.5 };
  await complete(req);
  assert.equal(req.temperature, 0.5, "original req must be untouched");
});

test("the warning is one-time per (model, param) across many calls", async () => {
  const inner = strictModelComplete();
  const warnings = [];
  const complete = withSamplingParamStrip(inner, { warn: (m) => warnings.push(m) });
  for (let i = 0; i < 5; i++) {
    await complete({ prompt: "p", model: "claude-opus-4-8", temperature: 0.7, persona: "x" });
  }
  assert.equal(warnings.length, 1, "5 identical (model,param) calls ⇒ exactly one warning");
});

test("an accepting model (Haiku) passes temperature through untouched, no warning", async () => {
  const inner = async (req) => ({ ok: true, text: "[]", echoed: req.temperature });
  const warnings = [];
  const complete = withSamplingParamStrip(inner, { warn: (m) => warnings.push(m) });
  const res = await complete({ prompt: "p", model: "claude-haiku-4-5", temperature: 0.6 });
  assert.equal(res.echoed, 0.6, "Haiku accepts ⇒ temperature forwarded");
  assert.equal(warnings.length, 0);
});

test("a default-panel run against a rejecting model completes (no silent empty pool)", async () => {
  // Without the strip, every agent's temperature 400s, safeComplete swallows it,
  // and the pool is silently empty. With it, the panel produces candidates.
  const inner = strictModelComplete();
  const stripped = withSamplingParamStrip(inner, { warn: () => {} });
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: ({ persona }) => `R1 ${persona}`,
      complete: stripped,
      models: { round1: "claude-opus-4-8" }, // route the whole default panel here
    },
  );
  assert.ok(candidates.length > 0, "the panel must produce candidates through the strip");

  // Control: the SAME panel WITHOUT the strip yields the silent empty pool.
  const bare = strictModelComplete();
  const { candidates: none } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: ({ persona }) => `R1 ${persona}`, complete: bare, models: { round1: "claude-opus-4-8" } },
  );
  assert.equal(none.length, 0, "without the strip, the rejecting model yields an empty pool");
});
