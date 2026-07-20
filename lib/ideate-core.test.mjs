// Tests for ideate-core.mjs. Fully offline — the model client is
// injected and returns scripted JSON. No network, no model calls.
// Run: node --test lib/ideate-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ideateCore,
  foldHumanIdeas,
  extractCandidates,
  resolveAgents,
  makeResolveComplete,
  resolveMaxRounds,
  roundConfig,
  DEFAULT_TEMPERATURES,
  DEFAULT_PERSONAS,
  DEFAULT_AGENT_COUNT,
  DEFAULT_IDEAS_PER_AGENT,
  DEFAULT_MAX_ROUNDS,
} from "./ideate-core.mjs";

// Minimal prompt builders that mark the temperature + round so a scripted
// client can branch on them.
function buildRound1Prompt({ context, temperature, stance }) {
  return `ROUND1 slug=${context.slug} TEMP=${temperature.toUpperCase()} ${stance}`;
}
function buildRound2Prompt({ temperature, seeds }) {
  return `EXPAND TEMP=${temperature.toUpperCase()} seeds=${seeds.map((s) => s.text).join("|")}`;
}

// Scripted completion keyed on round + temperature, returning messy output to
// exercise the resilient parser.
function scriptedComplete() {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const isRound2 = /^EXPAND/.test(req.prompt);
    const temp = DEFAULT_TEMPERATURES.find((t) => req.prompt.includes("TEMP=" + t.toUpperCase()));

    if (isRound2) {
      return {
        ok: true,
        text:
          "Here you go:\n```json\n" +
          JSON.stringify([{ text: `R2 ${temp} idea`, tag: "expanded" }]) +
          "\n```\nDone.",
      };
    }
    if (temp === "conservative") {
      // bare array
      return { ok: true, text: JSON.stringify([{ text: "Conservative idea one.", tag: "c1" }]) };
    }
    if (temp === "normal") {
      // fenced + a malformed (no text) entry that must be dropped
      return {
        ok: true,
        text:
          "```json\n" +
          JSON.stringify([
            { text: "Normal idea one.", tag: "n1" },
            { tag: "no-text-dropped" },
          ]) +
          "\n```",
      };
    }
    if (temp === "wacky") {
      // object wrapper + surrounding prose
      return {
        ok: true,
        text: 'Sure! {"ideas":[{"text":"Wacky idea one.","tag":"w1"}]} hope that helps',
      };
    }
    return { ok: true, text: "[]" };
  };
  fn.calls = calls;
  return fn;
}

// The pre-S1 temperature-stance tests run against the LEGACY temperature panel
// (deps.temperatures), which the S1 agent model preserves for backward-compat.
function baseDeps(extra = {}) {
  return {
    buildRound1Prompt,
    buildRound2Prompt,
    temperatures: DEFAULT_TEMPERATURES,
    ...extra,
  };
}

test("all temperatures are represented across round-1", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete }),
  );
  const r1 = candidates.filter((c) => c.round === 1);
  const temps = new Set(r1.map((c) => c.temperature));
  for (const t of DEFAULT_TEMPERATURES) assert.ok(temps.has(t), `missing temperature ${t}`);
});

test("every candidate carries required core fields + stable slug-prefixed id", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete }),
  );
  assert.ok(candidates.length > 0);
  const ids = new Set();
  for (const c of candidates) {
    assert.equal(typeof c.id, "string");
    assert.ok(c.id.startsWith("demo-"), `id should be slug-prefixed: ${c.id}`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.equal(typeof c.text, "string");
    assert.ok(c.text.length > 0);
    assert.ok(typeof c.temperature === "string");
    assert.ok(c.round === 1 || c.round === 2);
    assert.equal(c.origin, "generated");
  }
});

test("caller-supplied extra fields pass through via normalizeExtra", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({
      complete,
      normalizeExtra: (raw) => ({ tag: raw.tag || "untagged", domainFlag: true }),
    }),
  );
  const c1 = candidates.find((c) => c.text === "Conservative idea one.");
  assert.ok(c1);
  assert.equal(c1.tag, "c1");
  assert.equal(c1.domainFlag, true);
});

test("normalizeExtra returning null drops the candidate", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({
      complete,
      // veto every wacky candidate
      normalizeExtra: (raw, ctx) => (ctx.temperature === "wacky" ? null : { tag: raw.tag }),
    }),
  );
  assert.ok(!candidates.some((c) => c.temperature === "wacky"));
  assert.ok(candidates.some((c) => c.temperature === "conservative"));
});

test("round-2 expansion produces round:2 candidates from round-1 seeds", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete }),
  );
  const r2 = candidates.filter((c) => c.round === 2);
  assert.ok(r2.length > 0, "expected round-2 candidates");
  for (const c of r2) assert.ok(/^R2 /.test(c.text));
  // round-2 prompt actually carried round-1 seed text
  const r2prompts = complete.calls.filter((r) => /^EXPAND/.test(r.prompt));
  assert.ok(r2prompts.some((r) => /Conservative idea one/.test(r.prompt)));
});

test("omitting buildRound2Prompt skips round 2 entirely", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt, complete, temperatures: DEFAULT_TEMPERATURES }, // no buildRound2Prompt
  );
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => c.round === 1));
});

test("malformed model output is dropped gracefully (no throw)", async () => {
  const complete = async (req) => {
    if (/^EXPAND/.test(req.prompt)) return { ok: false, reason: "http-error" };
    return { ok: true, text: "not json at all <<>>" };
  };
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete }),
  );
  assert.deepEqual(candidates, []);
});

test("the no-text candidate is dropped", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete }),
  );
  assert.ok(!candidates.some((c) => c.text === undefined));
  // normal round-1 had 2 raw entries; the textless one must not appear
  const normalsR1 = candidates.filter((c) => c.temperature === "normal" && c.round === 1);
  assert.equal(normalsR1.length, 1);
});

test("near-identical texts are de-duped globally", async () => {
  const dupComplete = async (req) => {
    if (/^EXPAND/.test(req.prompt)) return { ok: true, text: "[]" };
    return {
      ok: true,
      text: JSON.stringify([
        { text: "Same idea, said once." },
        { text: "Same idea, said once!!" },
      ]),
    };
  };
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    baseDeps({ complete: dupComplete }),
  );
  const matching = candidates.filter((c) => /same idea/i.test(c.text));
  assert.equal(matching.length, 1);
});

test("missing required deps throw clearly", async () => {
  await assert.rejects(
    () => ideateCore({ context: {} }, { complete: async () => ({ ok: true, text: "[]" }) }),
    /buildRound1Prompt/,
  );
});

test("no injected client throws the inject-a-client error", async () => {
  await assert.rejects(
    () => ideateCore({ context: { slug: "demo" } }, { buildRound1Prompt }),
    /inject/i,
  );
});

// ── Human-idea folding ──────────────────────────────────────────────────────

test("human ideas (strings) are folded in tagged origin:human", async () => {
  const complete = scriptedComplete();
  const { candidates } = await ideateCore(
    { context: { slug: "demo" }, humanIdeas: ["A human-written idea.", "Another human idea."] },
    baseDeps({ complete }),
  );
  const human = candidates.filter((c) => c.origin === "human");
  assert.equal(human.length, 2);
  for (const c of human) {
    assert.equal(typeof c.id, "string");
    assert.ok(c.text.length > 0);
    assert.equal(c.origin, "human");
  }
  // generated candidates are still present and tagged generated
  assert.ok(candidates.some((c) => c.origin === "generated"));
});

test("human idea objects pass extra fields through normalizeExtra", async () => {
  const complete = async () => ({ ok: true, text: "[]" });
  const { candidates } = await ideateCore(
    {
      context: { slug: "demo" },
      humanIdeas: [{ text: "Tagged human idea.", tag: "vip", priority: 9 }],
    },
    baseDeps({ complete, normalizeExtra: (raw) => ({ tag: raw.tag, priority: raw.priority }) }),
  );
  const c = candidates.find((x) => x.origin === "human");
  assert.ok(c);
  assert.equal(c.tag, "vip");
  assert.equal(c.priority, 9);
});

test("foldHumanIdeas honors an explicit stable id and dedups id collisions", () => {
  const out = foldHumanIdeas(
    [
      { id: "fixed-1", text: "First." },
      { id: "fixed-1", text: "Collision — same id, dropped." },
      { text: "Auto id." },
    ],
    { context: { slug: "demo" } },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "fixed-1");
  assert.equal(out[0].text, "First.");
  // the second fixed-1 is dropped as an id collision
  assert.ok(!out.some((c) => c.text.startsWith("Collision")));
  // auto id is slug-prefixed and origin:human
  const auto = out.find((c) => c.text === "Auto id.");
  assert.ok(auto.id.startsWith("demo-human-"));
  assert.equal(auto.origin, "human");
});

test("a near-identical human idea WINS over its generated twin (human shadows generated)", async () => {
  const complete = async (req) => {
    if (/^EXPAND/.test(req.prompt)) return { ok: true, text: "[]" };
    const temp = DEFAULT_TEMPERATURES.find((t) => req.prompt.includes("TEMP=" + t.toUpperCase()));
    if (temp === "conservative") {
      return { ok: true, text: JSON.stringify([{ text: "Kill the feature, not the dream." }]) };
    }
    return { ok: true, text: "[]" };
  };
  const { candidates } = await ideateCore(
    {
      context: { slug: "demo" },
      humanIdeas: ["Kill the feature, not the dream!!"], // punctuation-only diff
    },
    baseDeps({ complete }),
  );
  const matching = candidates.filter((c) => /kill the feature/i.test(c.text));
  assert.equal(matching.length, 1);
  // The HUMAN survivor wins — its wording steers, not the generated twin's.
  assert.equal(matching[0].origin, "human");
  assert.equal(matching[0].text, "Kill the feature, not the dream!!");
});

test("empty / non-array humanIdeas is a no-op", async () => {
  assert.deepEqual(foldHumanIdeas(undefined), []);
  assert.deepEqual(foldHumanIdeas([]), []);
  assert.deepEqual(foldHumanIdeas("nope"), []);
});

// ── S1: persona-diverse independent multi-agent generation ───────────────────

function personaPrompt({ context, persona, stance, ideasPerAgent }) {
  return `R1 slug=${context.slug} PERSONA=${persona} N=${ideasPerAgent} ${stance}`;
}

// A scripted client that echoes which persona (and an optional provider tag)
// asked, so tests can assert independence + cross-provider routing. It NEVER
// sees another agent's output — round 1 is blind.
function personaClient(providerTag = "") {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const persona = req.persona || "unknown";
    return {
      ok: true,
      text: JSON.stringify([
        { text: `${providerTag}${persona} idea A`, persona },
        { text: `${providerTag}${persona} idea B`, persona },
      ]),
    };
  };
  fn.calls = calls;
  return fn;
}

test("default round-1 panel is the 5 distinct personas (S1)", async () => {
  const complete = personaClient();
  const { candidates, agents, meta } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: personaPrompt, complete },
  );
  assert.equal(agents.length, DEFAULT_AGENT_COUNT);
  const personas = new Set(agents.map((a) => a.persona));
  for (const p of DEFAULT_PERSONAS) {
    assert.ok(personas.has(p.persona), `missing persona ${p.persona}`);
  }
  assert.equal(meta.independence, "blind");
  for (const c of candidates.filter((x) => x.origin === "generated")) {
    assert.ok(c.persona, "candidate must carry its persona");
    assert.ok(c.agentId, "candidate must carry its agentId");
    assert.equal(c.temperature, c.persona);
  }
});

test("agentCount drives the panel size (S1)", async () => {
  const complete = personaClient();
  const { agents } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: personaPrompt, complete, agentCount: 3 },
  );
  assert.equal(agents.length, 3);
});

test("round-1 agents share NO context — independence is blind (S1)", async () => {
  const complete = personaClient();
  await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: personaPrompt, complete },
  );
  // exactly one round-1 call per agent, and no agent's prompt carries another
  // agent's produced idea text (blind — round 1 shares no seeds).
  assert.equal(complete.calls.length, DEFAULT_AGENT_COUNT);
  for (const call of complete.calls) {
    assert.ok(!/idea A|idea B/.test(call.prompt), "round-1 prompt must not carry sibling output");
  }
});

test("cross-provider panel routes each agent to its assigned client (S1)", async () => {
  // Two heterogeneous providers, selected per-agent by model id — offline mocks,
  // no secrets, no network.
  const anthropic = personaClient("ANTH:");
  const openai = personaClient("OAI:");
  const agents = [
    { persona: "pragmatist", model: "claude-x" },
    { persona: "contrarian", model: "gpt-x" },
    { persona: "visionary", model: "claude-x" },
  ];
  const { candidates, meta } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: personaPrompt, clients: { "claude-x": anthropic, "gpt-x": openai }, agents },
  );
  assert.equal(meta.crossProvider, true);
  assert.equal(anthropic.calls.length, 2); // the two claude-x agents
  assert.equal(openai.calls.length, 1); // the one gpt-x agent
  const gptCand = candidates.find((c) => c.persona === "contrarian");
  assert.equal(gptCand.model, "gpt-x");
  assert.ok(candidates.some((c) => /^OAI:/.test(c.text)));
  assert.ok(candidates.some((c) => /^ANTH:/.test(c.text)));
});

test("resolveClient is used when the clients map lacks the model (S1)", async () => {
  const fallback = personaClient("FB:");
  const { candidates } = await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: personaPrompt,
      clients: {},
      resolveClient: (modelId) => (modelId === "grok-x" ? fallback : null),
      agents: [{ persona: "pragmatist", model: "grok-x" }],
    },
  );
  assert.ok(candidates.some((c) => /^FB:/.test(c.text)));
});

test("ideasPerAgent is passed to the prompt builder and defaults to 6 (S1)", async () => {
  let seenN;
  const complete = personaClient();
  await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: (a) => {
        seenN = a.ideasPerAgent;
        return personaPrompt(a);
      },
      complete,
      agentCount: 1,
    },
  );
  assert.equal(seenN, DEFAULT_IDEAS_PER_AGENT);
});

test("no client at all throws the inject-a-client error (S1)", async () => {
  await assert.rejects(
    () => ideateCore({ context: { slug: "demo" } }, { buildRound1Prompt: personaPrompt }),
    /inject/i,
  );
});

test("resolveAgents fills named-persona defaults and de-collides ids (S1)", () => {
  const agents = resolveAgents({ agents: [{ persona: "pragmatist" }, { persona: "pragmatist" }] });
  assert.equal(agents.length, 2);
  assert.notEqual(agents[0].id, agents[1].id); // id collision de-collided
  assert.ok(Number.isFinite(agents[0].temperature));
  assert.equal(agents[0].ideasPerAgent, DEFAULT_IDEAS_PER_AGENT);
  // a named persona picks up that persona's stance, not a positional one
  const named = resolveAgents({ agents: [{ persona: "x" }, { persona: "visionary" }] });
  const vis = DEFAULT_PERSONAS.find((p) => p.persona === "visionary");
  assert.equal(named[1].stance, vis.stance);
});

test("makeResolveComplete precedence: clients > resolveClient > complete (S1)", () => {
  const a = async () => ({ ok: true, text: "[]" });
  const b = async () => ({ ok: true, text: "[]" });
  const c = async () => ({ ok: true, text: "[]" });
  const resolve = makeResolveComplete({ clients: { m1: a }, resolveClient: () => b, complete: c });
  assert.equal(resolve("m1"), a); // map wins
  assert.equal(resolve("m2"), b); // resolveClient next
  assert.equal(makeResolveComplete({ complete: c })("anything"), c); // single-client fallback
  assert.equal(makeResolveComplete({}), null); // nothing injected
});

// ── S2: configurable sharing policy (blind→pool) + dedupe-before-share ───────

// A client giving each persona a distinct round-1 idea (pragmatist + contrarian
// emit a near-duplicate pair to exercise dedupe-before-share), and a per-round
// build-on marker so pooled seeds are observable.
function poolClient() {
  const r2prompts = [];
  const fn = async (req) => {
    if (/^BUILDON/.test(req.prompt)) {
      r2prompts.push(req.prompt);
      const round = (req.prompt.match(/round=(\d+)/) || [])[1];
      return { ok: true, text: JSON.stringify([{ text: `built by ${req.persona} r${round}` }]) };
    }
    const persona = req.persona;
    if (persona === "pragmatist") return { ok: true, text: JSON.stringify([{ text: "Ship a referral loop." }]) };
    if (persona === "contrarian") return { ok: true, text: JSON.stringify([{ text: "Ship a referral loop!!" }]) };
    return { ok: true, text: JSON.stringify([{ text: `${persona} seed` }]) };
  };
  fn.r2prompts = r2prompts;
  return fn;
}
const poolR1Prompt = ({ persona }) => `R1 ${persona}`;
const poolR2Prompt = ({ persona, round, seeds, sharing, buildOnDirective, incubation }) =>
  `BUILDON persona=${persona} round=${round} sharing=${sharing} inc=${incubation} ` +
  `dir=${buildOnDirective ? "yes" : "no"} seeds=[${seeds.map((s) => s.text).join(" | ")}]`;

test("round 2 builds on the deduped SHARED pool, not per-agent seeds (S2)", async () => {
  const complete = poolClient();
  const { meta } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: poolR1Prompt, buildRound2Prompt: poolR2Prompt, complete },
  );
  assert.equal(meta.sharing[0], "blind"); // round 1 blind
  assert.equal(meta.sharing[1], "pool"); // round 2 pool by default
  assert.equal(meta.dedupeBeforeShare, true);
  // A single agent's round-2 prompt references OTHER agents' seeds — only pool
  // sharing can produce that (per-agent seeds never would).
  const prag = complete.r2prompts.find((p) => /persona=pragmatist/.test(p));
  assert.ok(/visionary seed/.test(prag) && /outsider-analogy seed/.test(prag), "must see sibling seeds (pool)");
  // dedupe-before-share: the near-duplicate referral-loop pair is collapsed to 1.
  assert.equal((prag.match(/Ship a referral loop/g) || []).length, 1);
  // build-on directive + incubation are wired into the prompt.
  assert.ok(/dir=yes/.test(prag));
  assert.ok(/inc=true/.test(prag)); // incubation defaults true on build-on rounds
});

test("sharing:'blind' round 2 uses only the agent's own seeds (S2)", async () => {
  const complete = poolClient();
  await ideateCore(
    { context: { slug: "demo" } },
    {
      buildRound1Prompt: poolR1Prompt,
      buildRound2Prompt: poolR2Prompt,
      complete,
      rounds: [{}, { sharing: "blind" }],
    },
  );
  const prag = complete.r2prompts.find((p) => /persona=pragmatist/.test(p));
  assert.ok(/sharing=blind/.test(prag));
  assert.ok(/Ship a referral loop/.test(prag));
  assert.ok(!/visionary seed/.test(prag), "blind sharing must not leak sibling seeds");
});

test("maxRounds is configurable; default is 2 (S2)", async () => {
  const complete = poolClient();
  const { candidates, meta } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: poolR1Prompt, buildRound2Prompt: poolR2Prompt, complete, maxRounds: 3 },
  );
  assert.equal(meta.maxRounds, 3);
  assert.ok(candidates.some((c) => c.round === 3), "expected a round-3 candidate");
  const { meta: m2 } = await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: poolR1Prompt, buildRound2Prompt: poolR2Prompt, complete },
  );
  assert.equal(m2.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.ok(!(await ideateCore(
    { context: { slug: "demo" } },
    { buildRound1Prompt: poolR1Prompt, buildRound2Prompt: poolR2Prompt, complete },
  )).candidates.some((c) => c.round === 3));
});

test("roundConfig defaults: round 1 blind, round 2+ pool; per-round override (S2)", () => {
  assert.equal(roundConfig(1, {}).sharing, "blind");
  assert.equal(roundConfig(2, {}).sharing, "pool");
  assert.equal(roundConfig(1, {}).buildOnDirective, null); // no build-on directive on round 1
  assert.ok(roundConfig(2, {}).buildOnDirective); // present on build-on rounds
  assert.equal(roundConfig(2, { rounds: [{}, { sharing: "blind" }] }).sharing, "blind");
  assert.equal(roundConfig(2, { rounds: [{}, { incubation: false }] }).incubation, false);
  assert.equal(resolveMaxRounds({}), DEFAULT_MAX_ROUNDS);
  assert.equal(resolveMaxRounds({ maxRounds: 4 }), 4);
  assert.equal(resolveMaxRounds({ rounds: [{}, {}, {}] }), 3);
});

// ── extractCandidates unit coverage ─────────────────────────────────────────
test("extractCandidates tolerates fences, prose, and object wrappers", () => {
  assert.deepEqual(extractCandidates('[{"text":"a"}]'), [{ text: "a" }]);
  assert.deepEqual(extractCandidates('```json\n[{"text":"b"}]\n```'), [{ text: "b" }]);
  assert.deepEqual(extractCandidates('Sure:\n[{"text":"c"}]\nthanks'), [{ text: "c" }]);
  assert.deepEqual(extractCandidates('{"candidates":[{"text":"d"}]}'), [{ text: "d" }]);
  assert.deepEqual(extractCandidates('{"ideas":[{"text":"e"}]}'), [{ text: "e" }]);
  assert.deepEqual(extractCandidates("garbage"), []);
  assert.deepEqual(extractCandidates(""), []);
});
