// ideate-core.mjs — domain-agnostic ideation engine (cwc#737, epic #735).
//
// A reusable multi-agent, multi-round idea generator extracted from the RSB
// social V5 engine (social/lib/ideate.mjs). It owns ONLY the generic machinery:
//   - round 1: N INDEPENDENT generator agents (the nominal-group analog — the
//     strongest divergence result in the literature: Taylor 1958; Diehl &
//     Stroebe 1987; Mullen et al. 1991). Each agent is a SEPARATE model call
//     with NO shared context (independence: "blind") — the anti-mode-collapse
//     core (Si et al. 2024; Doshi & Hauser 2024). Diversity is ENGINEERED via
//     per-agent levers (persona, per-provider model, temperature, prompt
//     strategy), not wished for ("be diverse" alone fails — Meincke, Mollick &
//     Terwiesch 2024; persona > temperature as a lever — Wang et al. 2023),
//   - a round-2 expansion pass that builds NEW candidates from round-1 seeds,
//   - robust JSON extraction (tolerate ```json fences / surrounding prose /
//     {candidates:[...]} wrappers, drop malformed candidates rather than throw),
//   - normalization + global dedup,
//   - a PROVIDER-AGNOSTIC injectable model client: a single `complete` client,
//     OR a `model-id → client` resolver map / function, so a heterogeneous
//     CROSS-PROVIDER panel (Anthropic + OpenAI + xAI/Grok + …) runs with no
//     vendor SDK baked in (heterogeneous models give real variance and sidestep
//     self-preference bias — Wataoka et al. 2024), and
//   - folding caller-supplied HUMAN ideas into the candidate pool so they flow
//     through the same downstream gates the caller applies.
//
// Everything DOMAIN-specific (prompt copy, the grounding contract, extra
// candidate fields, channel/format/etc.) is supplied by the caller through
// injected prompt-builders and a per-candidate post-processor. The core never
// imports a model client or any social code.
//
// Discipline (matches the source engine):
//   - zero-dep ESM,
//   - the model client is INJECTABLE; with NO client resolvable the default
//     throws a clear "inject a client" error so tests/callers must supply one,
//   - ROBUST to messy model output: never throw on a bad reply, drop malformed
//     candidates instead.
//
// ── Core candidate shape (REQUIRED) ──────────────────────────────────────────
// Every emitted candidate carries at minimum:
//   {
//     id: string,                    // stable within a run; see makeId below
//     text: string,                  // the idea body (non-empty)
//     temperature: string,           // the brief/persona label that produced it
//     persona: string,               // the agent persona label (=temperature)
//     agentId: string,               // which round-1 agent produced it
//     model: string|undefined,       // the model id the producing agent used
//     round: number,                 // 1 (agents) | 2 (expansion)
//     origin: "generated"|"human",   // provenance; human ideas are folded in
//     ...extra                       // caller-supplied pass-through fields
//   }
// The caller's `normalizeExtra` hook may add/override any field EXCEPT it must
// not strip the required core fields (they are reapplied after it runs).

// ── Round-1 agent panel (S1) ─────────────────────────────────────────────────
// The default panel is a set of DISTINCT PERSONAS, not temperature stances:
// persona is a stronger diversity lever than temperature (Wang et al. 2023),
// and chain-of-thought yields the highest diversity (Meincke et al. 2024), so
// most personas default to a "cot" prompt strategy. Callers override any field
// per agent (including `model` — route each agent to a different provider).
export const DEFAULT_PERSONAS = [
  {
    persona: "pragmatist",
    stance:
      "PRAGMATIST: practical, resource-aware, shippable. Favor ideas that a small team could start on Monday. Prefer clarity and feasibility over cleverness.",
    temperature: 0.4,
    strategy: "direct",
  },
  {
    persona: "contrarian",
    stance:
      "CONTRARIAN: challenge the obvious. Invert the default assumption, argue the opposite of the expected move, and surface what everyone is ignoring.",
    temperature: 0.9,
    strategy: "cot",
  },
  {
    persona: "domain-expert",
    stance:
      "DOMAIN-EXPERT: a deep specialist. Apply hard-won craft knowledge and non-obvious best practice; cite the mechanism, not just the vibe.",
    temperature: 0.6,
    strategy: "cot",
  },
  {
    persona: "outsider-analogy",
    stance:
      "OUTSIDER-ANALOGY: import a mechanism from an unrelated field (biology, logistics, games, nature) and reason by analogy into this problem.",
    temperature: 1.0,
    strategy: "cot",
  },
  {
    persona: "visionary",
    stance:
      "VISIONARY: aim for 10x, not 10%. Describe the ambitious end-state and work backward to a bold first move.",
    temperature: 1.0,
    strategy: "cot",
  },
];

export const DEFAULT_AGENT_COUNT = 5;
export const DEFAULT_IDEAS_PER_AGENT = 6;

// Backward-compat: the pre-S1 engine used three temperature STANCES per round 1.
// Callers that still pass `deps.temperatures` (or the legacy `deps.stances` /
// `deps.tempValues`) get a temperature-derived agent panel instead of the
// persona panel — see resolveAgents below.
export const DEFAULT_TEMPERATURES = ["conservative", "normal", "wacky"];

/**
 * Default stance copy per temperature (LEGACY temperature panel only).
 */
export const DEFAULT_TEMPERATURE_STANCE = {
  conservative: "CONSERVATIVE: safe, credible, low-risk. Favor clarity over cleverness.",
  normal: "NORMAL: balanced. A clear idea with a little voice.",
  wacky: "WACKY: bold, provocative. Take a sharp angle or a surprising reframe.",
};

const DEFAULT_TEMP_VALUE = { conservative: 0.3, normal: 0.7, wacky: 1.0 };

function noClientInjected() {
  throw new Error(
    "ideate-core: no model client injected. Pass deps.complete " +
      "(async (req) => ({ ok, text, ... })), or deps.clients ({ modelId: complete }) / " +
      "deps.resolveClient (modelId => complete) for a cross-provider panel. " +
      "The core never ships a default client.",
  );
}

/**
 * Generate idea candidates across an INDEPENDENT round-1 agent panel and an
 * optional expansion round, then optionally fold in human-supplied ideas.
 * Fully injectable and provider-agnostic.
 *
 * @param {object} input
 *   @param {object} [input.context]    opaque domain context handed to prompt-builders.
 *   @param {Array}  [input.humanIdeas] human-supplied ideas (strings or objects)
 *                                       folded into the pool (origin:"human").
 * @param {object} deps
 *   @param {function}  [deps.complete]  async (req)=>{ok,text,...}. The single-client
 *                                        path. REQUIRED unless deps.clients or
 *                                        deps.resolveClient is provided.
 *   @param {object}    [deps.clients]   { modelId: complete } map for a cross-provider
 *                                        panel; an agent's assigned `model` routes here.
 *   @param {function}  [deps.resolveClient] (modelId)=>complete|null. Called when
 *                                        deps.clients lacks the model; falls back to
 *                                        deps.complete.
 *   @param {function}  deps.buildRound1Prompt ({context,agent,persona,stance,temperature,
 *                                        temperatureValue,strategy,ideasPerAgent,model})=>string. REQUIRED.
 *   @param {function}  [deps.buildRound2Prompt] ({context,agent,persona,stance,temperature,seeds})=>string.
 *                                        Omit/return falsy to skip round 2.
 *   @param {Array}     [deps.agents]    explicit agent panel; each entry may set
 *                                        { id, persona, stance, temperature, strategy, ideasPerAgent, model }.
 *                                        Missing fields fall back to DEFAULT_PERSONAS by index.
 *   @param {number}    [deps.agentCount] size of the default persona panel (default 5).
 *   @param {number}    [deps.ideasPerAgent] ideas requested per agent per round (default 6).
 *   @param {string[]}  [deps.temperatures] LEGACY: derive a temperature-stance panel instead.
 *   @param {object}    [deps.stances]    LEGACY temperature->stance copy.
 *   @param {object}    [deps.tempValues] LEGACY temperature->numeric temp.
 *   @param {function}  [deps.parse]      (text)=>rawCandidate[]; default extractCandidates.
 *   @param {function}  [deps.normalizeExtra] (raw, ctx)=>object|null. ctx = {temperature,
 *                                        persona, agentId, model, round, n, context, origin}.
 *   @param {function}  [deps.makeId]     (ctx)=>string id. ctx as above (+ extra).
 *   @param {object}    [deps.models]     { round1, round2 } fallback model id overrides.
 *   @param {number}    [deps.maxTokens]  per-call max tokens (default 2048).
 *   @param {function}  [deps.dedupeKey]  (candidate)=>string; default normalized text.
 * @returns {Promise<{candidates: object[], agents: object[], meta: object}>}
 */
export async function ideateCore(input = {}, deps = {}) {
  const resolveComplete = makeResolveComplete(deps);
  if (!resolveComplete) noClientInjected();
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
  const models = deps.models || {};
  const maxTokens = deps.maxTokens || 2048;
  const dedupeKey = typeof deps.dedupeKey === "function" ? deps.dedupeKey : defaultDedupeKey;
  const context = input.context;

  const agents = resolveAgents(deps);

  const candidates = [];

  // ── Round 1 — one INDEPENDENT agent per panel slot (fired CONCURRENTLY) ──────
  // Each agent's prompt is built ONLY from { context, agent } — no other agent's
  // output is visible to it (independence: "blind"). We fire all agents at once
  // and then build candidates in panel order so id assignment stays stable.
  const round1ByAgent = {};
  const r1Results = await Promise.all(
    agents.map((agent) => {
      const complete = resolveComplete(agent.model);
      if (!complete) return Promise.resolve(null);
      return safeComplete(complete, {
        prompt: buildRound1Prompt(round1PromptArgs(context, agent)),
        model: agent.model || models.round1,
        temperature: agent.temperature,
        maxTokens,
        // pass-throughs a client may use for routing / prompt strategy:
        persona: agent.persona,
        strategy: agent.strategy,
        ideasPerAgent: agent.ideasPerAgent,
      });
    }),
  );
  agents.forEach((agent, ai) => {
    round1ByAgent[agent.id] = [];
    const res = r1Results[ai];
    if (!res) return;
    const raw = safeParse(parse, res.text);
    for (const c of raw) {
      const cand = buildCandidate(c, {
        temperature: agent.persona,
        persona: agent.persona,
        agentId: agent.id,
        model: agent.model,
        round: 1,
        n: round1ByAgent[agent.id].length + 1,
        context,
        origin: "generated",
        normalizeExtra,
        makeId,
      });
      if (cand) round1ByAgent[agent.id].push(cand);
    }
    candidates.push(...round1ByAgent[agent.id]);
  });

  // ── Round 2 — expansion over each agent's round-1 seeds (CONCURRENT) ─────────
  // Each agent's expansion depends only on its OWN round-1 seeds, all of which
  // are ready now. (S2 replaces this per-agent expansion with a configurable
  // blind→pool sharing policy; S1 keeps the per-agent seeding.)
  if (buildRound2Prompt && candidates.length) {
    const r2Inputs = agents.map((agent) => {
      const seeds = round1ByAgent[agent.id];
      if (!seeds.length) return null;
      const prompt = buildRound2Prompt({ ...round1PromptArgs(context, agent), seeds });
      if (!prompt) return null;
      return { agent, prompt };
    });
    const r2Results = await Promise.all(
      r2Inputs.map((inp) => {
        if (!inp) return Promise.resolve(null);
        const complete = resolveComplete(inp.agent.model);
        if (!complete) return Promise.resolve(null);
        return safeComplete(complete, {
          prompt: inp.prompt,
          model: inp.agent.model || models.round2 || models.round1,
          temperature: inp.agent.temperature,
          maxTokens,
          persona: inp.agent.persona,
          strategy: inp.agent.strategy,
          ideasPerAgent: inp.agent.ideasPerAgent,
        });
      }),
    );
    r2Inputs.forEach((inp, ai) => {
      if (!inp) return;
      const res = r2Results[ai];
      if (!res) return;
      const raw = safeParse(parse, res.text);
      let n = 1;
      for (const c of raw) {
        const cand = buildCandidate(c, {
          temperature: inp.agent.persona,
          persona: inp.agent.persona,
          agentId: inp.agent.id,
          model: inp.agent.model,
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

  // ── Fold in human-supplied ideas ────────────────────────────────────────────
  const human = foldHumanIdeas(input.humanIdeas, {
    context,
    normalizeExtra,
    makeId,
  });

  // Human ideas come FIRST in the dedup input so a near-identical human idea
  // WINS over its generated twin — folding exists so the human's wording steers.
  return {
    candidates: dedupe([...human, ...candidates], dedupeKey),
    agents: agents.map((a) => ({ ...a })),
    meta: {
      independence: "blind",
      agentCount: agents.length,
      ideasPerAgent: agents.length ? agents[0].ideasPerAgent : DEFAULT_IDEAS_PER_AGENT,
      crossProvider: new Set(agents.map((a) => a.model || "").filter(Boolean)).size > 1,
    },
  };
}

// ── Round-1 agent panel resolution (S1) ──────────────────────────────────────

/**
 * Resolve the round-1 agent panel from deps. Precedence:
 *   1. deps.agents (explicit panel) — each entry filled from DEFAULT_PERSONAS by index.
 *   2. deps.temperatures (LEGACY) — a temperature-stance panel, backward-compatible
 *      with the pre-S1 engine (persona label = temperature; stance/temp from
 *      deps.stances / deps.tempValues).
 *   3. the default persona panel of deps.agentCount agents (default 5).
 * Every returned agent has: { id, persona, stance, temperature (numeric),
 * strategy, ideasPerAgent, model }.
 */
export function resolveAgents(deps = {}) {
  const ideasPerAgent =
    Number.isFinite(deps.ideasPerAgent) && deps.ideasPerAgent > 0
      ? deps.ideasPerAgent
      : DEFAULT_IDEAS_PER_AGENT;

  let raw;
  if (Array.isArray(deps.agents) && deps.agents.length) {
    raw = deps.agents.map((a, i) => {
      const spec = a && typeof a === "object" ? a : { persona: String(a) };
      // Fill missing fields from the DEFAULT_PERSONAS entry that matches by NAME
      // when the caller named a known persona, else by panel index.
      const base =
        (spec.persona && DEFAULT_PERSONAS.find((p) => p.persona === spec.persona)) ||
        DEFAULT_PERSONAS[i % DEFAULT_PERSONAS.length];
      const persona = spec.persona || base.persona;
      return {
        persona,
        stance: spec.stance || base.stance,
        temperature: Number.isFinite(spec.temperature) ? spec.temperature : base.temperature,
        strategy: spec.strategy || base.strategy,
        ideasPerAgent:
          Number.isFinite(spec.ideasPerAgent) && spec.ideasPerAgent > 0
            ? spec.ideasPerAgent
            : ideasPerAgent,
        model: spec.model,
        id: spec.id,
      };
    });
  } else if (Array.isArray(deps.temperatures) && deps.temperatures.length) {
    const stances = deps.stances || DEFAULT_TEMPERATURE_STANCE;
    const tempValues = deps.tempValues || DEFAULT_TEMP_VALUE;
    raw = deps.temperatures.map((t) => ({
      persona: t,
      stance: stances[t] || t,
      temperature: Number.isFinite(tempValues[t]) ? tempValues[t] : 0.7,
      strategy: "direct",
      ideasPerAgent,
      model: undefined,
      id: undefined,
    }));
  } else {
    const count =
      Number.isFinite(deps.agentCount) && deps.agentCount > 0
        ? Math.floor(deps.agentCount)
        : DEFAULT_AGENT_COUNT;
    raw = Array.from({ length: count }, (_, i) => {
      const base = DEFAULT_PERSONAS[i % DEFAULT_PERSONAS.length];
      return { ...base, ideasPerAgent, model: undefined, id: undefined };
    });
  }

  // Assign stable, unique ids (default: persona label, de-collided with a suffix).
  const seen = new Map();
  return raw.map((a) => {
    let id = a.id && typeof a.id === "string" && a.id.trim() ? a.id.trim() : a.persona;
    if (seen.has(id)) {
      const nextN = seen.get(id) + 1;
      seen.set(id, nextN);
      id = `${id}-${nextN}`;
    } else {
      seen.set(id, 1);
    }
    return { ...a, id };
  });
}

function round1PromptArgs(context, agent) {
  return {
    context,
    agent,
    persona: agent.persona,
    stance: agent.stance,
    // `temperature` carries the persona LABEL for backward-compat with pre-S1
    // prompt builders that branched on the stance label; the numeric model
    // temperature is `temperatureValue`.
    temperature: agent.persona,
    temperatureValue: agent.temperature,
    strategy: agent.strategy,
    ideasPerAgent: agent.ideasPerAgent,
    model: agent.model,
  };
}

/**
 * Build a client resolver from deps. Returns null when NO client is injectable.
 * The resolver `(modelId) => complete|null` routes each agent to its provider:
 *   - deps.clients[modelId] if present,
 *   - else deps.resolveClient(modelId) if a function,
 *   - else deps.complete (single-client fallback; model routed via req.model).
 */
export function makeResolveComplete(deps = {}) {
  const clients = deps.clients && typeof deps.clients === "object" ? deps.clients : null;
  const resolveClient =
    typeof deps.resolveClient === "function" ? deps.resolveClient : null;
  const single = typeof deps.complete === "function" ? deps.complete : null;
  if (!clients && !resolveClient && !single) return null;
  return (modelId) => {
    if (clients && modelId && typeof clients[modelId] === "function") return clients[modelId];
    if (resolveClient) {
      const c = resolveClient(modelId);
      if (typeof c === "function") return c;
    }
    return single;
  };
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
      persona: temperature,
      agentId: "human",
      model: undefined,
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
    persona: ctx.persona,
    agentId: ctx.agentId,
    model: ctx.model,
    round: ctx.round,
    n: ctx.n,
    context: ctx.context,
    origin: ctx.origin,
  });
  if (extra === null) return null; // caller vetoed this candidate

  const id = ctx.makeId({
    temperature: ctx.temperature,
    persona: ctx.persona,
    agentId: ctx.agentId,
    model: ctx.model,
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
    persona: ctx.persona,
    agentId: ctx.agentId,
    model: ctx.model,
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
