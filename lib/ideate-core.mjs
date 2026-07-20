// ideate-core.mjs — domain-agnostic ideation engine (cwc#737, epic #735).
//
// A reusable multi-temperature, multi-round idea generator extracted from the
// RSB social V5 engine (social/lib/ideate.mjs). It owns ONLY the generic
// machinery:
//   - multiple temperature briefs in round 1 (e.g. conservative | normal | wacky),
//   - a round-2 expansion pass that builds NEW candidates from round-1 seeds,
//   - robust JSON extraction (tolerate ```json fences / surrounding prose /
//     {candidates:[...]} wrappers, drop malformed candidates rather than throw),
//   - normalization + global dedup,
//   - an injectable model `complete` client (so tests stay offline), and
//   - NEW: folding caller-supplied HUMAN ideas into the candidate pool so they
//     flow through the same downstream gates the caller applies.
//
// Everything DOMAIN-specific (prompt copy, the grounding contract, extra
// candidate fields, channel/format/etc.) is supplied by the caller through
// injected prompt-builders and a per-candidate post-processor. The core never
// imports a model client or any social code.
//
// Discipline (matches the source engine):
//   - zero-dep ESM,
//   - the model client is INJECTABLE; the default throws a clear "inject a
//     client" error so tests/callers must supply one,
//   - ROBUST to messy model output: never throw on a bad reply, drop malformed
//     candidates instead.
//
// ── Core candidate shape (REQUIRED) ──────────────────────────────────────────
// Every emitted candidate carries at minimum:
//   {
//     id: string,                    // stable within a run; see makeId below
//     text: string,                  // the idea body (non-empty)
//     temperature: string,           // the brief that produced it
//     round: number,                 // 1 (briefs) | 2 (expansion)
//     origin: "generated"|"human",   // provenance; human ideas are folded in
//     ...extra                       // caller-supplied pass-through fields
//   }
// The caller's `normalizeExtra` hook may add/override any field EXCEPT it must
// not strip the required core fields (they are reapplied after it runs).

export const DEFAULT_TEMPERATURES = ["conservative", "normal", "wacky"];

/**
 * Default stance copy per temperature (generic; callers usually override via
 * buildRound1Prompt / buildRound2Prompt with domain-specific briefs).
 */
export const DEFAULT_TEMPERATURE_STANCE = {
  conservative: "CONSERVATIVE: safe, credible, low-risk. Favor clarity over cleverness.",
  normal: "NORMAL: balanced. A clear idea with a little voice.",
  wacky: "WACKY: bold, provocative. Take a sharp angle or a surprising reframe.",
};

const DEFAULT_TEMP_VALUE = { conservative: 0.3, normal: 0.7, wacky: 1.0 };

function noClientInjected() {
  throw new Error(
    "ideate-core: no model `complete` client injected. Pass deps.complete " +
      "(async (req) => ({ ok, text, ... })). The core never ships a default client.",
  );
}

/**
 * Generate idea candidates across temperature briefs and an optional expansion
 * round, then optionally fold in human-supplied ideas. Fully injectable.
 *
 * @param {object} input
 *   @param {object} [input.context]    opaque domain context handed to prompt-builders.
 *   @param {Array}  [input.humanIdeas] human-supplied ideas (strings or objects)
 *                                       folded into the pool (origin:"human").
 * @param {object} deps
 *   @param {function}  deps.complete         async (req)=>{ok,text,...}. REQUIRED.
 *   @param {function}  deps.buildRound1Prompt ({context,temperature,stance})=>string. REQUIRED.
 *   @param {function}  [deps.buildRound2Prompt] ({context,temperature,stance,seeds})=>string.
 *                                        Omit/return falsy to skip round 2.
 *   @param {function}  [deps.parse]      (text)=>rawCandidate[]; default extractCandidates.
 *   @param {function}  [deps.normalizeExtra] (raw, ctx)=>object|null. Maps a raw model
 *                                        object to caller-domain fields; return null to drop.
 *                                        ctx = {temperature, round, n, context, origin}.
 *   @param {function}  [deps.makeId]     (ctx)=>string id. ctx as above (+ idSeed).
 *   @param {string[]}  [deps.temperatures] default DEFAULT_TEMPERATURES.
 *   @param {object}    [deps.stances]    temperature->stance copy. default DEFAULT_TEMPERATURE_STANCE.
 *   @param {object}    [deps.tempValues] temperature->numeric model temp.
 *   @param {object}    [deps.models]     { round1, round2 } model id overrides.
 *   @param {number}    [deps.maxTokens]  per-call max tokens (default 2048).
 *   @param {boolean}   [deps.rounds]     deprecated alias; see buildRound2Prompt.
 *   @param {function}  [deps.dedupeKey]  (candidate)=>string; default normalized text.
 * @returns {Promise<{candidates: object[]}>}
 */
export async function ideateCore(input = {}, deps = {}) {
  if (typeof deps.complete !== "function") noClientInjected();
  const complete = deps.complete;
  const buildRound1Prompt = deps.buildRound1Prompt;
  if (typeof buildRound1Prompt !== "function") {
    throw new Error("ideate-core: deps.buildRound1Prompt (function) is required");
  }
  const buildRound2Prompt =
    typeof deps.buildRound2Prompt === "function" ? deps.buildRound2Prompt : null;
  const parse = deps.parse || extractCandidates;
  const normalizeExtra =
    typeof deps.normalizeExtra === "function" ? deps.normalizeExtra : passthroughExtra;
  const makeId = typeof deps.makeId === "function" ? deps.makeId : defaultMakeId;
  const temperatures =
    Array.isArray(deps.temperatures) && deps.temperatures.length
      ? deps.temperatures
      : DEFAULT_TEMPERATURES;
  const stances = deps.stances || DEFAULT_TEMPERATURE_STANCE;
  const tempValues = deps.tempValues || DEFAULT_TEMP_VALUE;
  const models = deps.models || {};
  const maxTokens = deps.maxTokens || 2048;
  const dedupeKey = typeof deps.dedupeKey === "function" ? deps.dedupeKey : defaultDedupeKey;
  const context = input.context;

  const candidates = [];

  // ── Round 1 — one brief per temperature (fired CONCURRENTLY) ────────────────
  // The briefs are independent, so we fire all temperatures at once and then
  // build candidates in temperature order — keeping id assignment and the push
  // sequence byte-identical to the old sequential loop.
  const round1ByTemp = {};
  const r1Results = await Promise.all(
    temperatures.map((temperature) =>
      safeComplete(complete, {
        prompt: buildRound1Prompt({
          context,
          temperature,
          stance: stances[temperature] || temperature,
        }),
        model: models.round1,
        temperature: tempValues[temperature],
        maxTokens,
      }),
    ),
  );
  temperatures.forEach((temperature, ti) => {
    round1ByTemp[temperature] = [];
    const res = r1Results[ti];
    if (!res) return;
    const raw = safeParse(parse, res.text);
    for (const c of raw) {
      const cand = buildCandidate(c, {
        temperature,
        round: 1,
        n: round1ByTemp[temperature].length + 1,
        context,
        origin: "generated",
        normalizeExtra,
        makeId,
      });
      if (cand) round1ByTemp[temperature].push(cand);
    }
    candidates.push(...round1ByTemp[temperature]);
  });

  // ── Round 2 — expansion over each temperature's round-1 seeds (CONCURRENT) ──
  // Each temperature's expansion depends only on its OWN round-1 seeds, all of
  // which are ready now — so fire them concurrently, then build candidates in
  // temperature order to preserve id/push sequence.
  if (buildRound2Prompt && candidates.length) {
    const r2Inputs = temperatures.map((temperature) => {
      const seeds = round1ByTemp[temperature];
      if (!seeds.length) return null;
      const stance = stances[temperature] || temperature;
      const prompt = buildRound2Prompt({ context, temperature, stance, seeds });
      if (!prompt) return null;
      return { temperature, prompt };
    });
    const r2Results = await Promise.all(
      r2Inputs.map((inp) =>
        inp
          ? safeComplete(complete, {
              prompt: inp.prompt,
              model: models.round2 || models.round1,
              temperature: tempValues[inp.temperature],
              maxTokens,
            })
          : Promise.resolve(null),
      ),
    );
    r2Inputs.forEach((inp, ti) => {
      if (!inp) return;
      const res = r2Results[ti];
      if (!res) return;
      const raw = safeParse(parse, res.text);
      let n = 1;
      for (const c of raw) {
        const cand = buildCandidate(c, {
          temperature: inp.temperature,
          round: 2,
          n: n++,
          context,
          origin: "generated",
          normalizeExtra,
          makeId,
        });
        if (cand) candidates.push(cand);
      }
    });
  }

  // ── Fold in human-supplied ideas (NEW capability) ──────────────────────────
  const human = foldHumanIdeas(input.humanIdeas, {
    context,
    normalizeExtra,
    makeId,
  });

  // Human ideas come FIRST in the dedup input so a near-identical human idea
  // WINS over its generated twin — folding exists so the human's wording steers.
  return { candidates: dedupe([...human, ...candidates], dedupeKey) };
}

// ── Human-idea folding ──────────────────────────────────────────────────────

/**
 * Turn caller-supplied human ideas into core candidates tagged origin:"human"
 * so they flow through the SAME downstream gates the caller applies to
 * generated candidates. Pure + deterministic: no model calls.
 *
 * @param {Array<string|object>} humanIdeas  each entry is either a plain idea
 *        string, or an object `{ text, ...extra }`. The object's extra fields
 *        are passed through deps.normalizeExtra exactly like a model candidate.
 * @param {object} deps
 *   @param {object}   [deps.context]
 *   @param {function} [deps.normalizeExtra] (raw, ctx)=>object|null
 *   @param {function} [deps.makeId]
 *   @param {string}   [deps.temperature]  bucket label for human ideas (default "human")
 *   @param {number}   [deps.round]        round label for human ideas (default 0)
 * @returns {object[]} normalized human-origin candidates (deduped against each
 *          other by id; NOT deduped against generated here — that happens in
 *          ideateCore, which lists human ideas FIRST so a human idea WINS over a
 *          near-identical generated twin and the human's wording steers).
 */
export function foldHumanIdeas(humanIdeas, deps = {}) {
  if (!Array.isArray(humanIdeas) || !humanIdeas.length) return [];
  const normalizeExtra =
    typeof deps.normalizeExtra === "function" ? deps.normalizeExtra : passthroughExtra;
  const makeId = typeof deps.makeId === "function" ? deps.makeId : defaultMakeId;
  const temperature = deps.temperature || "human";
  const round = typeof deps.round === "number" ? deps.round : 0;
  const context = deps.context;

  const out = [];
  const seenIds = new Set();
  let n = 0;
  for (const entry of humanIdeas) {
    n += 1;
    const raw =
      typeof entry === "string"
        ? { text: entry }
        : entry && typeof entry === "object"
          ? { ...entry }
          : null;
    if (!raw) continue;
    const cand = buildCandidate(raw, {
      temperature,
      round,
      n,
      context,
      origin: "human",
      normalizeExtra,
      makeId,
    });
    if (!cand) continue;
    // Stable id: prefer an explicit id from the human entry, else the generated one.
    const explicitId =
      raw.id && typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
    if (explicitId) cand.id = explicitId;
    if (seenIds.has(cand.id)) continue; // id collision among human ideas -> skip dup
    seenIds.add(cand.id);
    out.push(cand);
  }
  return out;
}

// ── Candidate assembly ──────────────────────────────────────────────────────

function buildCandidate(raw, ctx) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return null;

  const extra = ctx.normalizeExtra(raw, {
    temperature: ctx.temperature,
    round: ctx.round,
    n: ctx.n,
    context: ctx.context,
    origin: ctx.origin,
  });
  if (extra === null) return null; // caller vetoed this candidate

  const id = ctx.makeId({
    temperature: ctx.temperature,
    round: ctx.round,
    n: ctx.n,
    context: ctx.context,
    origin: ctx.origin,
    extra,
  });

  // Required core fields are reapplied LAST so a misbehaving normalizeExtra
  // cannot clobber the contract.
  return {
    ...extra,
    id,
    text,
    temperature: ctx.temperature,
    round: ctx.round,
    origin: ctx.origin,
  };
}

function passthroughExtra(raw) {
  // Default: pass through everything except text (reapplied by buildCandidate).
  const { text, ...rest } = raw || {};
  return { ...rest };
}

function defaultMakeId(ctx) {
  const slug =
    ctx.context && typeof ctx.context.slug === "string" ? ctx.context.slug : "idea";
  return `${slug}-${ctx.temperature}-r${ctx.round}-${ctx.n}`;
}

// ── Model call guard ────────────────────────────────────────────────────────

async function safeComplete(complete, req) {
  let res;
  try {
    res = await complete(req);
  } catch {
    return null;
  }
  if (!res || res.ok !== true || typeof res.text !== "string") return null;
  return res;
}

// ── Robust parsing ──────────────────────────────────────────────────────────

function safeParse(parse, text) {
  try {
    const out = parse(text);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * Extract a candidate array from a model reply. Tolerates:
 *   - bare JSON arrays,
 *   - ```json fenced blocks,
 *   - leading/trailing prose around the array,
 *   - an object wrapper like { candidates: [...] } / { posts: [...] } / { ideas: [...] }.
 * Returns [] on total failure; never throws.
 */
export function extractCandidates(text) {
  if (typeof text !== "string" || !text.trim()) return [];

  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();

  const direct = tryJson(body);
  if (direct !== undefined) return coerceArray(direct);

  const arr = sliceBalanced(body, "[", "]");
  if (arr !== null) {
    const parsed = tryJson(arr);
    if (parsed !== undefined) return coerceArray(parsed);
  }
  const obj = sliceBalanced(body, "{", "}");
  if (obj !== null) {
    const parsed = tryJson(obj);
    if (parsed !== undefined) return coerceArray(parsed);
  }
  return [];
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function coerceArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    if (Array.isArray(v.candidates)) return v.candidates;
    if (Array.isArray(v.posts)) return v.posts;
    if (Array.isArray(v.ideas)) return v.ideas;
  }
  return [];
}

function sliceBalanced(s, open, close) {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ── Dedup ───────────────────────────────────────────────────────────────────

function dedupe(candidates, keyFn) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = keyFn(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function defaultDedupeKey(c) {
  return normText(c && c.text);
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}
