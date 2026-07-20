// converge.mjs — the divergent→convergent second half of ideate-core (S3, #5).
//
// ideateCore diverges: it produces a large, deliberately varied POOL. Divergence
// without convergence is noise — naive LLM pools are ~95% near-duplicate (Si et
// al. 2024), and text-normalized dedup misses SEMANTIC duplicates. This module
// converges a pool into a shortlist worth a human's attention:
//
//   1. Embedding-cosine dedup   — collapse semantic near-duplicates a text key
//                                 misses (default threshold 0.83; Si et al. 2024).
//   2. Clustering (k auto)      — group by theme so selection samples ACROSS
//                                 modes, not within one (Doshi & Hauser 2024).
//   3. Split-axis scoring       — novelty and feasibility on SEPARATE axes, never
//                                 collapsed to one "best" (selectors reliably pick
//                                 feasible-over-original — Rietzschel et al. 2010).
//   4. Cross-cluster selection  — sampleAcrossClusters + topN shortlist.
//   5. Human-rerank hook        — the top-N is handed to a human; an LLM-judge is
//                                 a FILTER, not a novelty ranker (Zheng et al.
//                                 2023). Human rerank is what lifted quality
//                                 (Si et al. 2024).
//   6. Diversity metric         — report pool cosine-diversity vs a floor; measure
//                                 diversity, don't assume it (Meincke et al. 2024).
//
// Discipline matches ideate-core: zero-dep ESM, the embedder is INJECTABLE
// (provider-agnostic, offline-mockable), robust to a missing/failing embedder
// (falls back to text-normalized dedup, never throws on a bad vector).

export const DEFAULT_DEDUPE_THRESHOLD = 0.83; // cosine sim >= this ⇒ near-duplicate
export const DEFAULT_CLUSTER_THRESHOLD = 0.6; // leader-clustering assignment sim (k auto)
export const DEFAULT_TOP_N = 10;

// ── Vector math ──────────────────────────────────────────────────────────────

export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Attach an `embedding` vector to each candidate via the injected embedder.
 * `embed` is async (texts:string[]) => number[][] (one vector per text). On any
 * failure, or when embed is not a function, returns items unchanged (embedding
 * left undefined) so callers degrade to text-normalized dedup — never throws.
 */
export async function embedCandidates(candidates, embed) {
  if (typeof embed !== "function" || !Array.isArray(candidates) || !candidates.length) {
    return candidates.map((c) => ({ ...c }));
  }
  let vectors;
  try {
    vectors = await embed(candidates.map((c) => String(c.text || "")));
  } catch {
    vectors = null;
  }
  if (!Array.isArray(vectors) || vectors.length !== candidates.length) {
    return candidates.map((c) => ({ ...c }));
  }
  return candidates.map((c, i) => ({
    ...c,
    embedding: Array.isArray(vectors[i]) ? vectors[i] : undefined,
  }));
}

// ── 1. Embedding-cosine dedup ────────────────────────────────────────────────

/**
 * Greedy semantic dedup: keep the first occurrence; drop any later item whose
 * cosine similarity to an already-kept item is >= threshold. Items WITHOUT an
 * embedding fall back to exact normalized-text matching so a missing embedder
 * still dedups the obvious duplicates. Order-stable; keeps the earlier item (so
 * a humans-first ordering keeps the human's wording, matching ideateCore).
 */
export function semanticDedupe(items, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_DEDUPE_THRESHOLD;
  const kept = [];
  const keptTextKeys = new Set();
  for (const item of items) {
    const emb = item && item.embedding;
    if (Array.isArray(emb)) {
      let dup = false;
      for (const k of kept) {
        if (Array.isArray(k.embedding) && cosineSim(emb, k.embedding) >= threshold) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      kept.push(item);
    } else {
      const key = normText(item && item.text);
      if (keptTextKeys.has(key)) continue;
      keptTextKeys.add(key);
      kept.push(item);
    }
  }
  return kept;
}

// ── 2. Clustering (k auto) ───────────────────────────────────────────────────

/**
 * Cluster items by embedding so selection can sample across themes.
 *   - k === "auto" (default): leader clustering — assign each item to the first
 *     existing cluster whose centroid similarity >= clusterThreshold, else start
 *     a new cluster. k emerges from the data.
 *   - k === <number>: agglomerative — start each item its own cluster, merge the
 *     two most-similar clusters until k remain.
 * Items without embeddings each form a singleton cluster. Returns
 * [{ id, members: item[], centroid: number[]|null }], deterministic.
 */
export function clusterByEmbedding(items, opts = {}) {
  const k = opts.k === undefined ? "auto" : opts.k;
  const withEmb = items.filter((it) => Array.isArray(it.embedding));
  const without = items.filter((it) => !Array.isArray(it.embedding));

  let clusters;
  if (Number.isFinite(k) && k >= 1) {
    clusters = agglomerative(withEmb, Math.floor(k));
  } else {
    const threshold = Number.isFinite(opts.clusterThreshold)
      ? opts.clusterThreshold
      : DEFAULT_CLUSTER_THRESHOLD;
    clusters = leaderCluster(withEmb, threshold);
  }
  // each embedding-less item is its own singleton cluster
  for (const it of without) clusters.push({ members: [it], centroid: null });
  return clusters.map((c, i) => ({ id: `cluster-${i + 1}`, members: c.members, centroid: c.centroid }));
}

function leaderCluster(items, threshold) {
  const clusters = [];
  for (const it of items) {
    let best = null;
    let bestSim = -Infinity;
    for (const c of clusters) {
      const sim = cosineSim(it.embedding, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= threshold) {
      best.members.push(it);
      best.centroid = meanVector(best.members.map((m) => m.embedding));
    } else {
      clusters.push({ members: [it], centroid: it.embedding.slice() });
    }
  }
  return clusters;
}

function agglomerative(items, k) {
  let clusters = items.map((it) => ({ members: [it], centroid: it.embedding.slice() }));
  while (clusters.length > k && clusters.length > 1) {
    let bi = 0;
    let bj = 1;
    let bestSim = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosineSim(clusters[i].centroid, clusters[j].centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bi = i;
          bj = j;
        }
      }
    }
    const merged = {
      members: clusters[bi].members.concat(clusters[bj].members),
      centroid: null,
    };
    merged.centroid = meanVector(merged.members.map((m) => m.embedding));
    clusters = clusters.filter((_, idx) => idx !== bi && idx !== bj);
    clusters.push(merged);
  }
  return clusters;
}

function meanVector(vectors) {
  const valid = vectors.filter((v) => Array.isArray(v) && v.length);
  if (!valid.length) return null;
  const len = valid[0].length;
  const out = new Array(len).fill(0);
  for (const v of valid) for (let i = 0; i < len; i++) out[i] += Number(v[i]) || 0;
  for (let i = 0; i < len; i++) out[i] /= valid.length;
  return out;
}

// ── 3. Split-axis scoring (novelty ⟂ feasibility) ────────────────────────────

/**
 * Score every item on TWO SEPARATE axes — never collapsed to one number:
 *   - novelty:     1 - (max cosine sim to any OTHER item). Embedding-derived;
 *                  higher ⇒ more distinct from the rest of the pool.
 *   - feasibility: from an injected `scoreFeasibility(item)` (0..1, sync/async),
 *                  the LLM-judge FILTER lane — null when no scorer is injected
 *                  (feasibility is unknown, NOT zero; we never invent it).
 * Returns items with { scores: { novelty, feasibility } } attached.
 */
export async function scoreAxes(items, opts = {}) {
  const scoreFeasibility =
    typeof opts.scoreFeasibility === "function" ? opts.scoreFeasibility : null;
  const feas = [];
  for (const it of items) {
    if (!scoreFeasibility) {
      feas.push(null);
      continue;
    }
    let v = null;
    try {
      v = await scoreFeasibility(it);
    } catch {
      v = null;
    }
    feas.push(Number.isFinite(v) ? clamp01(v) : null);
  }
  return items.map((it, i) => {
    let maxSim = -Infinity;
    if (Array.isArray(it.embedding)) {
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        if (!Array.isArray(items[j].embedding)) continue;
        const sim = cosineSim(it.embedding, items[j].embedding);
        if (sim > maxSim) maxSim = sim;
      }
    }
    const novelty = maxSim === -Infinity ? null : clamp01(1 - maxSim);
    return { ...it, scores: { novelty, feasibility: feas[i] } };
  });
}

// ── 4. Cross-cluster selection ───────────────────────────────────────────────

/**
 * Build a topN shortlist. With sampleAcrossClusters (default true), take the
 * best item (by novelty, feasibility as a tiebreak) from each cluster
 * round-robin so the shortlist spans THEMES rather than piling into one mode.
 * Otherwise take the global top-N by novelty. Never collapses the two axes into
 * a single ranking key beyond this deterministic tiebreak.
 */
export function selectShortlist(scoredItems, clusters, opts = {}) {
  const topN = Number.isFinite(opts.topN) && opts.topN > 0 ? Math.floor(opts.topN) : DEFAULT_TOP_N;
  const across = opts.sampleAcrossClusters !== false;
  const byId = new Map(scoredItems.map((it) => [it.id, it]));

  if (!across) {
    return scoredItems.slice().sort(cmpNovelty).slice(0, topN);
  }

  // rank within each cluster, then round-robin across clusters
  const ranked = clusters.map((c) =>
    c.members
      .map((m) => byId.get(m.id) || m)
      .slice()
      .sort(cmpNovelty),
  );
  const out = [];
  let depth = 0;
  while (out.length < topN) {
    let took = false;
    for (const clusterRanked of ranked) {
      if (clusterRanked[depth]) {
        out.push(clusterRanked[depth]);
        took = true;
        if (out.length >= topN) break;
      }
    }
    if (!took) break;
    depth++;
  }
  return out;
}

function cmpNovelty(a, b) {
  const an = a.scores && Number.isFinite(a.scores.novelty) ? a.scores.novelty : -1;
  const bn = b.scores && Number.isFinite(b.scores.novelty) ? b.scores.novelty : -1;
  if (bn !== an) return bn - an;
  const af = a.scores && Number.isFinite(a.scores.feasibility) ? a.scores.feasibility : -1;
  const bf = b.scores && Number.isFinite(b.scores.feasibility) ? b.scores.feasibility : -1;
  return bf - af;
}

// ── 6. Diversity metric ──────────────────────────────────────────────────────

/**
 * Mean pairwise cosine DISTANCE (1 - sim) across the embedded pool ∈ [0,1].
 * Higher ⇒ more diverse. Returns null when < 2 items carry embeddings.
 */
export function poolDiversity(items) {
  const embs = items.map((it) => it.embedding).filter((e) => Array.isArray(e));
  if (embs.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < embs.length; i++) {
    for (let j = i + 1; j < embs.length; j++) {
      sum += 1 - cosineSim(embs[i], embs[j]);
      n++;
    }
  }
  return n ? sum / n : null;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Converge a candidate pool. Pure of ideateCore — run it on ANY candidate list.
 *
 * @param {object[]} candidates  the divergent pool (from ideateCore or elsewhere).
 * @param {object} deps
 *   @param {function} [deps.embed]            async (texts)=>vectors[][]. Injected embedder.
 *   @param {function} [deps.scoreFeasibility] (item)=>0..1. Injected LLM-judge FILTER.
 *   @param {function} [deps.humanRerank]      async (shortlist)=>reranked. Human-rerank hook.
 *   @param {object}   [deps.convergence]      { dedupe:{threshold}, cluster:{k,clusterThreshold},
 *                                               selection:{topN,sampleAcrossClusters}, diversityFloor }.
 * @returns {Promise<{pool, clusters, shortlist, shortlistPreRerank, reranked,
 *          diversity, diversityFloor, diversityFloorMet}>}
 */
export async function convergePool(candidates, deps = {}) {
  const cfg = (deps.convergence && typeof deps.convergence === "object" ? deps.convergence : {}) || {};
  const list = Array.isArray(candidates) ? candidates : [];

  const embedded = await embedCandidates(list, deps.embed);
  const pool = semanticDedupe(embedded, cfg.dedupe || {});
  const clusters = clusterByEmbedding(pool, cfg.cluster || {});
  const scored = await scoreAxes(pool, { scoreFeasibility: deps.scoreFeasibility });
  // re-key clusters' members to the scored items so shortlist carries scores
  const shortlist = selectShortlist(scored, clusters, cfg.selection || {});

  let finalShortlist = shortlist;
  let reranked = false;
  if (typeof deps.humanRerank === "function") {
    try {
      const out = await deps.humanRerank(shortlist);
      if (Array.isArray(out) && out.length) {
        finalShortlist = out;
        reranked = true;
      }
    } catch {
      /* human-rerank hook failure is non-fatal: keep the machine shortlist */
    }
  }

  const diversity = poolDiversity(pool);
  const floor = Number.isFinite(cfg.diversityFloor) ? cfg.diversityFloor : null;
  return {
    pool: scored,
    clusters,
    shortlist: finalShortlist,
    shortlistPreRerank: shortlist,
    reranked,
    diversity,
    diversityFloor: floor,
    diversityFloorMet: floor === null || diversity === null ? null : diversity >= floor,
  };
}

// ── shared helpers ───────────────────────────────────────────────────────────

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}
