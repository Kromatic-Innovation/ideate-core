// Tests for converge.mjs (S3, #5). Fully offline — the embedder + feasibility
// scorer + human-rerank hook are all injected mocks. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSim,
  embedCandidates,
  semanticDedupe,
  clusterByEmbedding,
  scoreAxes,
  selectShortlist,
  poolDiversity,
  convergePool,
  DEFAULT_DEDUPE_THRESHOLD,
} from "./converge.mjs";
import { ideateCore } from "./ideate-core.mjs";

const c = (id, text, embedding) => ({ id, text, embedding });

test("cosineSim: identical vectors = 1, orthogonal = 0, guards bad input", () => {
  assert.equal(cosineSim([1, 0], [1, 0]), 1);
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
  assert.equal(cosineSim([1, 0], [1, 0, 0]), 0); // length mismatch
  assert.equal(cosineSim(null, [1]), 0);
});

test("semanticDedupe collapses a semantic near-dup that a TEXT key misses (S3)", () => {
  // Two DIFFERENT texts ("a" vs "our") — a normalized-text key keeps both — but
  // identical embeddings ⇒ embedding dedup collapses them.
  const items = [
    c("1", "Launch a referral program", [1, 1, 0, 0]),
    c("2", "Launch our referral program", [1, 1, 0, 0]),
    c("3", "A/B test the pricing page", [1, 0, 0, 0]),
    c("4", "Send a weekly email digest", [0, 0, 1, 1]),
    c("5", "Start a monthly newsletter", [0, 0, 1, 0]),
  ];
  const kept = semanticDedupe(items, { threshold: 0.83 });
  const texts = kept.map((k) => k.text);
  assert.ok(texts.includes("Launch a referral program"));
  assert.ok(!texts.includes("Launch our referral program"), "semantic near-dup must be dropped");
  assert.equal(kept.length, 4); // the 0.707-similar pairs survive (< 0.83)
});

test("semanticDedupe falls back to normalized-text when embeddings are absent", () => {
  const items = [c("1", "Same idea."), c("2", "Same idea!!"), c("3", "Different.")];
  const kept = semanticDedupe(items, {});
  assert.equal(kept.length, 2);
});

test("clusterByEmbedding (auto) groups by theme; fixed-k agglomerates (S3)", () => {
  const items = [
    c("x1", "x1", [1, 1, 0, 0]),
    c("x2", "x2", [1, 0, 0, 0]),
    c("y1", "y1", [0, 0, 1, 1]),
    c("y2", "y2", [0, 0, 1, 0]),
  ];
  const auto = clusterByEmbedding(items, { k: "auto", clusterThreshold: 0.6 });
  assert.equal(auto.length, 2);
  for (const cl of auto) assert.equal(cl.members.length, 2);
  const fixed = clusterByEmbedding(items, { k: 1 });
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].members.length, 4);
});

test("scoreAxes keeps novelty and feasibility on SEPARATE axes (S3)", async () => {
  const items = [
    c("1", "one", [1, 0]),
    c("2", "two", [1, 0]), // identical → low novelty
    c("3", "three", [0, 1]), // distinct → high novelty
  ];
  const noScorer = await scoreAxes(items, {});
  assert.equal(noScorer[0].scores.feasibility, null); // no scorer ⇒ unknown, not 0
  assert.ok(noScorer[2].scores.novelty > noScorer[0].scores.novelty); // distinct item more novel
  const withScorer = await scoreAxes(items, { scoreFeasibility: (it) => (it.id === "1" ? 0.9 : 0.2) });
  assert.equal(withScorer[0].scores.feasibility, 0.9);
  // the two axes are independent: item 1 is high feasibility but low novelty
  assert.ok(withScorer[0].scores.feasibility > withScorer[0].scores.novelty);
});

test("selectShortlist samples ACROSS clusters and honors topN (S3)", async () => {
  const items = [
    c("x1", "x1", [1, 1, 0, 0]),
    c("x2", "x2", [1, 0, 0, 0]),
    c("y1", "y1", [0, 0, 1, 1]),
    c("y2", "y2", [0, 0, 1, 0]),
  ];
  const clusters = clusterByEmbedding(items, { k: "auto", clusterThreshold: 0.6 });
  const scored = await scoreAxes(items, {});
  const shortlist = selectShortlist(scored, clusters, { topN: 2, sampleAcrossClusters: true });
  assert.equal(shortlist.length, 2);
  // one from each cluster — the shortlist spans both themes, not one mode
  const ids = new Set(shortlist.map((s) => s.id));
  const themeX = ids.has("x1") || ids.has("x2");
  const themeY = ids.has("y1") || ids.has("y2");
  assert.ok(themeX && themeY, "shortlist must span both clusters");
});

test("poolDiversity is a mean pairwise cosine distance in [0,1]", () => {
  assert.equal(poolDiversity([c("1", "a", [1, 0]), c("2", "b", [0, 1])]), 1); // orthogonal
  assert.equal(poolDiversity([c("1", "a", [1, 0]), c("2", "b", [1, 0])]), 0); // identical
  assert.equal(poolDiversity([c("1", "a")]), null); // < 2 embedded
});

test("convergePool end-to-end: dedup + cluster + score + shortlist + rerank + diversity (S3)", async () => {
  const EMB = {
    "Launch a referral program": [1, 1, 0, 0],
    "Launch our referral program": [1, 1, 0, 0], // semantic dup, different text
    "A/B test the pricing page": [1, 0, 0, 0],
    "Send a weekly email digest": [0, 0, 1, 1],
    "Start a monthly newsletter": [0, 0, 1, 0],
  };
  const embed = async (texts) => texts.map((t) => EMB[t] || [0, 0, 0, 0]);
  const pool = Object.keys(EMB).map((t, i) => ({ id: String(i), text: t }));
  let rerankSaw = 0;
  const out = await convergePool(pool, {
    embed,
    scoreFeasibility: (it) => (/referral/i.test(it.text) ? 0.9 : 0.4),
    humanRerank: async (s) => {
      rerankSaw = s.length;
      return s.slice().reverse();
    },
    convergence: {
      dedupe: { threshold: 0.83 },
      cluster: { k: "auto", clusterThreshold: 0.6 },
      selection: { topN: 2, sampleAcrossClusters: true },
      diversityFloor: 0.1,
    },
  });
  assert.equal(out.pool.length, 4); // one semantic dup collapsed
  assert.equal(out.clusters.length, 2);
  assert.equal(out.shortlist.length, 2);
  assert.ok(out.reranked && rerankSaw === 2);
  // reranked shortlist is the reverse of the machine one
  assert.deepEqual(
    out.shortlist.map((s) => s.id),
    out.shortlistPreRerank.map((s) => s.id).reverse(),
  );
  assert.ok(Number.isFinite(out.diversity) && out.diversity > 0);
  assert.equal(out.diversityFloorMet, true);
  // split axes survive onto shortlist items
  for (const s of out.shortlist) {
    assert.ok("novelty" in s.scores && "feasibility" in s.scores);
  }
});

test("convergePool without an embedder degrades to text dedup, never throws (S3)", async () => {
  const pool = [
    { id: "1", text: "Same idea." },
    { id: "2", text: "Same idea!!" },
    { id: "3", text: "Other." },
  ];
  const out = await convergePool(pool, { convergence: {} });
  assert.equal(out.pool.length, 2); // text-normalized dedup
  assert.equal(out.diversity, null); // no embeddings ⇒ no diversity metric
});

test("embedCandidates tolerates a throwing/short embedder (degrades, no throw)", async () => {
  const items = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
  const thrown = await embedCandidates(items, async () => {
    throw new Error("embedder down");
  });
  assert.ok(thrown.every((i) => i.embedding === undefined));
  const short = await embedCandidates(items, async () => [[1, 0]]); // wrong length
  assert.ok(short.every((i) => i.embedding === undefined));
});

test("ideateCore convergence path attaches shortlist/clusters/diversity (S3 integration)", async () => {
  const complete = async (req) => {
    if (/^BUILDON/.test(req.prompt)) return { ok: true, text: "[]" };
    return { ok: true, text: JSON.stringify([{ text: "Referral program" }, { text: "Email digest" }]) };
  };
  const embed = async (texts) => texts.map((t) => (/referral/i.test(t) ? [1, 0] : [0, 1]));
  let rerankCalled = false;
  const { candidates, convergence, meta } = await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: ({ persona }) => `R1 ${persona}`,
      buildRound2Prompt: () => "BUILDON",
      complete,
      embed,
      convergence: { selection: { topN: 5 }, diversityFloor: 0.1 },
      humanRerank: async (s) => {
        rerankCalled = true;
        return s;
      },
    },
  );
  assert.equal(meta.converged, true);
  assert.ok(convergence);
  assert.ok(convergence.shortlist.length >= 1);
  assert.ok(rerankCalled && convergence.reranked);
  assert.ok(Number.isFinite(convergence.diversity));
  assert.equal(candidates, convergence.pool); // returned pool is the converged pool
  assert.equal(DEFAULT_DEDUPE_THRESHOLD, 0.83);
});
