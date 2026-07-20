// Tests for ideate-core.mjs (cwc#737). Fully offline — the model client is
// injected and returns scripted JSON. No network, no model calls.
// Run: node --test .claude/skills/ideation/lib/ideate-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ideateCore,
  foldHumanIdeas,
  extractCandidates,
  DEFAULT_TEMPERATURES,
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

function baseDeps(extra = {}) {
  return {
    buildRound1Prompt,
    buildRound2Prompt,
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
    { buildRound1Prompt, complete }, // no buildRound2Prompt
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
