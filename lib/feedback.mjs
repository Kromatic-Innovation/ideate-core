// feedback.mjs — the Delphi-style evaluate→regenerate loop (S4, #6).
//
// Controlled feedback (Dalkey & Helmer 1963; Rowe & Wright 1999): an EXTERNAL
// evaluator critiques the pool, and the engine runs a TARGETED regeneration of
// only the flagged ideas — "generate → vet → regenerate against the feedback."
// The evaluator must be a DIFFERENT model from the generators (self-preference
// bias — Wataoka et al. 2024).
//
// The evaluator is INJECTABLE and evaluator-agnostic. The feedback-in contract
// below is the canonical, provider-agnostic interface; any evaluator can target
// it. `exampleAdapterFromPanelist` is a WORKED EXAMPLE — not a required or
// canonical format — showing how to adapt one tool's (Kromatic's `panelist`)
// shipped spawn/score output ({verdict, message, dealKillers[]}, panelist#7) onto
// that contract; write your own adapter for other tools/shapes. The live
// panelist↔ideate wiring is the consumer's job (social-loop) — this module only
// defines the contract + the loop.
//
// ── Feedback-in data contract ────────────────────────────────────────────────
// The evaluator returns (per idea, split-axis scores — Rietzschel et al. 2010):
//   {
//     verdicts: [
//       {
//         ideaId: string,                       // which candidate this judges
//         decision: "keep" | "revise" | "kill",
//         scores: { novelty: number|null, feasibility: number|null },
//         dealKillers: string[],                // why it might die (feeds regen)
//         keepReasons: string[],                // what to preserve (feeds regen)
//       }, ...
//     ],
//     poolDirectives?: string[],                // pool-level steering for regen
//   }
// Engine behavior: keep → pass through; kill → drop; revise → targeted
// regeneration conditioned on { original idea, dealKillers, keepReasons }. The
// merged pool is re-deduped before the next round / selection.

import { makeResolveComplete, resolveAgents, extractCandidates } from "./ideate-core.mjs";

export const DEFAULT_MAX_REGEN_ROUNDS = 2;
export const FEEDBACK_DECISIONS = ["keep", "revise", "kill"];

// ── Contract normalization ───────────────────────────────────────────────────

const DECISION_SYNONYMS = {
  keep: "keep",
  pass: "keep",
  accept: "keep",
  approve: "keep",
  ok: "keep",
  revise: "revise",
  improve: "revise",
  refine: "revise",
  rework: "revise",
  kill: "kill",
  drop: "kill",
  reject: "kill",
  cut: "kill",
};

/**
 * Coerce a raw evaluator reply into the canonical feedback-in contract. Tolerant
 * (matching the rest of the engine): accepts `{verdicts,poolDirectives}` or a
 * bare verdict array; drops verdicts with no `ideaId`; unknown decisions default
 * to "keep" (never silently drop an idea on an ambiguous verdict).
 */
export function normalizeFeedback(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const rawVerdicts = Array.isArray(src) ? src : Array.isArray(src.verdicts) ? src.verdicts : [];
  const verdicts = [];
  for (const v of rawVerdicts) {
    if (!v || typeof v !== "object") continue;
    const ideaId = v.ideaId || v.id;
    if (!ideaId || typeof ideaId !== "string") continue;
    const decisionRaw = String(v.decision || v.verdict || "keep").toLowerCase().trim();
    const decision = DECISION_SYNONYMS[decisionRaw] || "keep";
    const scores = v.scores && typeof v.scores === "object" ? v.scores : {};
    verdicts.push({
      ideaId,
      decision,
      scores: {
        novelty: Number.isFinite(scores.novelty) ? scores.novelty : null,
        feasibility: Number.isFinite(scores.feasibility) ? scores.feasibility : null,
      },
      dealKillers: toStringArray(v.dealKillers),
      keepReasons: toStringArray(v.keepReasons),
    });
  }
  return {
    verdicts,
    poolDirectives: toStringArray(src.poolDirectives),
  };
}

/**
 * WORKED EXAMPLE — not a required or canonical format. Shows how to adapt one
 * tool's (Kromatic's `panelist`) shipped per-idea output ({verdict, message,
 * dealKillers[]}, panelist#7) into ideate-core's feedback-in contract. The
 * contract itself (see `normalizeFeedback` above) is provider-agnostic — write
 * your own adapter for other evaluators/shapes; this one is illustrative only.
 *
 * In this example panelist verdicts map pass→keep, revise→revise, kill→kill;
 * `message` becomes a keepReason; deal killers pass straight through. `ideaId`
 * must be supplied alongside (panelist scores an idea the caller identifies).
 *
 * @param {Array<{ideaId:string, verdict:string, message?:string, dealKillers?:string[],
 *          scores?:object}>} panelistVerdicts
 * @returns {object} feedback-in contract
 */
export function exampleAdapterFromPanelist(panelistVerdicts, poolDirectives = []) {
  const verdicts = (Array.isArray(panelistVerdicts) ? panelistVerdicts : []).map((p) => ({
    ideaId: p.ideaId || p.id,
    decision: p.verdict,
    scores: p.scores,
    dealKillers: p.dealKillers,
    keepReasons: p.message ? [p.message] : p.keepReasons,
  }));
  return normalizeFeedback({ verdicts, poolDirectives });
}

/**
 * @deprecated since 0.2.0 — renamed to {@link exampleAdapterFromPanelist} in #48
 * to signal it is a worked EXAMPLE adapter, not a required part of the API. This
 * alias preserves the export name shipped in `ideate-core@0.1.0` for one release
 * so a `0.1.0` consumer's `import { panelistToFeedback } from "ideate-core/feedback"`
 * keeps working; it will be removed in a future minor. Import
 * `exampleAdapterFromPanelist` instead.
 */
export const panelistToFeedback = exampleAdapterFromPanelist;

// ── The loop ─────────────────────────────────────────────────────────────────

/**
 * Run the evaluate→regenerate loop over a candidate pool.
 *
 * @param {object[]} candidates  the pool (post-divergence / post-convergence-dedup).
 * @param {object} deps
 *   @param {object}   deps.feedbackLoop  { maxRegenRounds=2, targeting="per-idea",
 *                                          evaluator:{ model } } — opt-in; absent ⇒ no-op.
 *   @param {function} deps.evaluate      async (pool, ctx) => feedback-in contract. REQUIRED.
 *   @param {function} deps.buildRegenPrompt ({context, original, dealKillers, keepReasons,
 *                                          poolDirectives, round}) => string. REQUIRED.
 *   @param {function} [deps.complete] / [deps.clients] / [deps.resolveClient]  generator client(s).
 *   @param {function} [deps.parse]     model-reply parser (default extractCandidates).
 * @param {object} [opts]  { context }
 * @returns {Promise<{candidates, feedback:{rounds, history, evaluatorDistinct}}>}
 */
export async function runFeedbackLoop(candidates, deps = {}, opts = {}) {
  const cfg = deps.feedbackLoop;
  const pool0 = Array.isArray(candidates) ? candidates.slice() : [];
  if (!cfg || typeof cfg !== "object") {
    return { candidates: pool0, feedback: { rounds: 0, history: [], evaluatorDistinct: true } };
  }
  if (typeof deps.evaluate !== "function") {
    throw new Error("ideate-core feedbackLoop: deps.evaluate (function) is required");
  }
  if (typeof deps.buildRegenPrompt !== "function") {
    throw new Error("ideate-core feedbackLoop: deps.buildRegenPrompt (function) is required");
  }
  const evaluatorDistinct = assertEvaluatorDistinct(cfg, deps);

  const context = opts.context;
  const maxRegen =
    Number.isFinite(cfg.maxRegenRounds) && cfg.maxRegenRounds >= 1
      ? Math.floor(cfg.maxRegenRounds)
      : DEFAULT_MAX_REGEN_ROUNDS;
  const parse = deps.parse || extractCandidates;
  const resolveComplete = makeResolveComplete(deps);

  let pool = pool0;
  const history = [];
  for (let round = 1; round <= maxRegen; round++) {
    const raw = await safeEvaluate(deps.evaluate, pool, { context, round });
    const fb = normalizeFeedback(raw);
    if (!fb.verdicts.length) break;

    const byId = new Map(pool.map((c) => [c.id, c]));
    const kept = [];
    const toRevise = [];
    let killed = 0;
    const verdictIds = new Set();
    for (const v of fb.verdicts) {
      verdictIds.add(v.ideaId);
      const original = byId.get(v.ideaId);
      if (!original) continue;
      if (v.decision === "kill") {
        killed++;
      } else if (v.decision === "revise") {
        toRevise.push({ original, verdict: v });
      } else {
        kept.push(original);
      }
    }
    // ideas the evaluator did not judge pass through untouched
    for (const c of pool) if (!verdictIds.has(c.id)) kept.push(c);

    const regenerated = [];
    for (const { original, verdict } of toRevise) {
      const cand = await regenerateOne(original, verdict, fb.poolDirectives, {
        context,
        round,
        parse,
        resolveComplete,
        buildRegenPrompt: deps.buildRegenPrompt,
        deps,
      });
      // On regen failure keep the original so a flagged idea is never lost.
      regenerated.push(cand || original);
    }

    pool = dedupeById([...kept, ...regenerated]);
    history.push({
      round,
      evaluated: fb.verdicts.length,
      kept: kept.length,
      killed,
      revised: toRevise.length,
      regenerated: regenerated.length,
      poolDirectives: fb.poolDirectives.length,
    });
    if (!toRevise.length && !killed) break; // converged — nothing to change
  }

  return { candidates: pool, feedback: { rounds: history.length, history, evaluatorDistinct } };
}

async function regenerateOne(original, verdict, poolDirectives, ctx) {
  const complete = ctx.resolveComplete ? ctx.resolveComplete(original.model) : null;
  if (!complete) return null;
  const prompt = ctx.buildRegenPrompt({
    context: ctx.context,
    original,
    dealKillers: verdict.dealKillers,
    keepReasons: verdict.keepReasons,
    poolDirectives,
    round: ctx.round,
  });
  if (!prompt) return null;
  let res;
  try {
    res = await complete({
      prompt,
      model: original.model,
      temperature: 0.7,
      maxTokens: 2048,
      persona: original.persona,
      round: original.round,
      regen: true,
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || typeof res.text !== "string") return null;
  let raw;
  try {
    raw = ctx.parse(res.text);
  } catch {
    raw = [];
  }
  const first = Array.isArray(raw) ? raw.find((r) => r && typeof r.text === "string" && r.text.trim()) : null;
  if (!first) return null;
  return {
    ...original,
    text: first.text.trim(),
    id: `${original.id}-rev${ctx.round}`,
    revisedFrom: original.id,
    dealKillersAddressed: verdict.dealKillers.slice(),
  };
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Enforce that the evaluator model differs from every generator model
 * (self-preference bias). Only checks when a concrete evaluator.model AND
 * concrete generator models are declared; returns whether they are distinct and
 * throws on a definite collision.
 */
export function assertEvaluatorDistinct(cfg, deps) {
  const evalModel = cfg && cfg.evaluator && cfg.evaluator.model;
  if (!evalModel) return true; // undeclared ⇒ caller's responsibility, treated distinct
  const genModels = resolveAgents(deps)
    .map((a) => a.model)
    .filter(Boolean);
  if (genModels.includes(evalModel)) {
    throw new Error(
      `ideate-core feedbackLoop: evaluator.model "${evalModel}" must DIFFER from every ` +
        "generator model (an evaluator that judges its own output is self-preference-biased).",
    );
  }
  return true;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeEvaluate(evaluate, pool, ctx) {
  try {
    return await evaluate(pool, ctx);
  } catch {
    return { verdicts: [] };
  }
}

function dedupeById(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function toStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : String(x))).filter((s) => s.trim());
}
