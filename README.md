# ideate-core

[![CI](https://github.com/Kromatic-Innovation/ideate-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Kromatic-Innovation/ideate-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/ideate-core.svg)](https://www.npmjs.com/package/ideate-core)

![ideate-core: three people building ideas together at a whiteboard covered in post-its](docs/assets/hero.png)

**Use case:** you need a pool of genuinely different ideas from an LLM — for a campaign brief, a product-naming pass, a strategy option set — not five rephrasings of the same idea with the temperature turned up.

**Differentiator:** most "ideation" wrappers are one model call with a "be creative" system prompt. "Ask the model for 5 ideas" reliably produces 5 idea *phrasings*. ideate-core instead engineers the diversity the way human brainwriting does: independent, blind generator agents (persona is the lever, not temperature — the research backs this), pooled through real build-on rounds, then optionally converged with embedding-dedup + split-axis scoring instead of one LLM-judge "best idea." It's a zero-dependency injectable function, not a framework — bring your own model client.

**A provider-agnostic, evidence-based ideation _engine_** — independent multi-agent generation, blind→pool brainwriting rounds, a divergent→convergent selection half, and an evaluate→regenerate feedback loop, as a zero-dependency injectable function. Not a framework, not model-locked: you bring the model client, the embedder, and the prompts.

## What it does

Turns a domain context into a pool of idea candidates by running a panel of **independent generator agents** (each a separate model call with no shared context — the nominal-group analog), optionally running an **expansion round** over round one, and folding in any **human-supplied ideas** so they ride the same downstream gates.

> Every research claim below (Wang et al. 2023, Meincke et al. 2024, Rohrbach 1968, …) is sourced in full — author + year + URL — in **[docs/ideation-method.md](docs/ideation-method.md#references)**, alongside a defaults→evidence table.

- **Independent multi-agent round 1** — N agents (default 5), each a separate blind model call. Diversity is _engineered_ via per-agent levers — **persona** (default: pragmatist / contrarian / domain-expert / outsider-analogy / visionary), **temperature**, and **prompt strategy** (chain-of-thought). "Be diverse" alone fails; persona beats temperature as a lever (Wang et al. 2023; Meincke et al. 2024).
- **Cross-provider panel** — route each agent to a different provider/model via an injected `clients` map or `resolveClient` resolver (Anthropic + OpenAI + xAI/Grok + …). No vendor SDK is baked in; heterogeneous models give real variance and sidestep self-preference bias (Wataoka et al. 2024).
- **Build-on rounds with a sharing policy** — round 1 is blind; build-on rounds (2+) default to **pool** sharing: agents build on the **shared, deduped** pool, not their own seeds — real brainwriting / 6-3-5 (Rohrbach 1968; Paulus & Yang 2000). Dedupe-before-share is mandatory for pool rounds (a raw pool triggers fixation — Kohn & Smith 2011). Per-round `sharing`, `incubation`, `buildOnDirective`, and `maxRounds` are all config-driven.
- **Human-idea folding** — caller ideas are normalized into the candidate shape and merged; a near-identical human idea wins the dedup tie.
- **Robust parsing** — tolerates ```json fences, surrounding prose, and `{candidates|ideas|posts:[...]}` wrappers; drops malformed candidates rather than throwing.
- **Convergence** (opt-in, `ideate-core/converge`) — the divergent→convergent second half: **embedding-cosine dedup** (default 0.83; collapses semantic near-dups a text key misses), **clustering** (k auto) so selection samples _across_ themes, **split-axis scoring** (novelty ⟂ feasibility, never one "best" — Rietzschel et al. 2010), a **cross-cluster shortlist**, a **human-rerank hook** (LLM-judge is a filter, not a novelty ranker — Zheng et al. 2023), and a **diversity metric** vs a floor. The embedder is injected (offline-mockable).
- **Evaluate→regenerate feedback loop** (opt-in, `ideate-core/feedback`) — a Delphi-style controlled-feedback loop (Dalkey & Helmer 1963): an **injected external evaluator** (`panelist` is the intended first one) critiques the pool, and only the flagged ideas are **targeted-regenerated** against their specific `dealKillers`/`keepReasons`; `keep` passes, `kill` drops, `revise` regenerates, then the pool re-dedupes. The evaluator model must differ from the generators (self-preference bias — Wataoka et al. 2024). The feedback-in contract itself is **provider-agnostic**; see `exampleAdapterFromPanelist` in `lib/feedback.mjs` for a worked example of adapting one evaluator's output shape onto it — the adapter is illustrative, not a required or canonical format.
- **Global dedup**, provider-agnostic injectable client + embedder (tests stay offline), zero domain code.

## Install

```bash
npm i ideate-core
```

Apache-2.0, published to the public npm registry (zero runtime dependencies, Node.js >= 20). Bring your own model client, embedder, and prompts.

**Prerequisite — you supply your own `complete()` model-calling function** (no API
client is bundled). Two shapes are contractual, and getting either wrong is
**silently dropped** — you get `candidates: []` with no error thrown:

- **`complete(req)` must resolve to `{ ok: true, text: string }`.** Anything else
  (a bare string, `{ text }` without `ok: true`, or a thrown error) yields no
  candidate. `req.prompt` is the string your `buildRound1Prompt` returned.
- **Each candidate in the model's JSON reply must be shaped `{ text: "..." }`**
  (a non-empty string `text`) — **not** `{ title, body }`. A bare JSON array, or a
  `{ candidates | posts | ideas: [...] }` wrapper, are all accepted; any object
  without a non-empty string `text` is dropped.

**Input validation is the caller's job.** ideate-core does **not** validate the
shape of `input.context` — the engine passes it straight through to *your*
`buildRound1Prompt`/prompt builders, so shape-validating `context` (and any other
`input` fields your adapter reads) is the calling adapter's responsibility, not the
engine's. This is intentional: the engine stays domain-agnostic and never throws on
your input.

```js
import { ideateCore } from "ideate-core";

// ── You bring two functions; ideate-core calls YOUR model through them. ──

// 1) complete(req) MUST resolve to { ok: true, text: string }. `text` is the
//    model's raw reply. Anything else is silently dropped (candidates: []).
const complete = async (req) => {
  const text = await callYourModel(req.prompt); // your provider call
  return { ok: true, text };                    // ← required return shape
};

// 2) buildRound1Prompt({ context, stance, persona, ... }) returns the prompt
//    string. Tell the model to reply with candidate objects each shaped
//    { "text": "..." } — NOT { title, body }.
const buildRound1Prompt = ({ context, stance }) =>
  `${stance ?? ""}\nGive 6 ideas for: ${context.brief}.\n` +
  `Reply ONLY with a JSON array like [{"text": "first idea"}, {"text": "second idea"}].`;

// Single-client panel (the default 5 personas all route to one client):
const { candidates } = await ideateCore(
  { context: { slug: "demo", brief: "ways to promote a launch" } },
  { complete, buildRound1Prompt /* , buildRound2Prompt, normalizeExtra */ },
);

// Cross-provider panel — one agent per provider (each client is its own
// `complete(req) => { ok: true, text }`, same contract as above):
const { candidates: pool } = await ideateCore(
  { context: { slug: "demo", brief: "…" } },
  {
    buildRound1Prompt,
    clients: { "claude-x": anthropicComplete, "gpt-x": openaiComplete },
    agents: [
      { persona: "pragmatist", model: "claude-x" },
      { persona: "contrarian", model: "gpt-x" },
    ],
  },
);
```

## CLI

A thin standalone CLI (`bin/ideate.mjs`, installed as `ideate`) wraps the same
engine for shell/pipeline use:

```bash
echo '{"context":{"slug":"demo"},"humanIdeas":["a seed idea"]}' \
  | ideate --adapter ./my-adapter.mjs   # ESM module exporting `deps` for ideateCore

ideate --version   # print the installed version
ideate --help      # full usage
```

Without `--adapter` the CLI runs **fold-only**: it folds `humanIdeas` from stdin
and prints them, no model client or API key required — useful for sanity-checking
the human-idea path before wiring a real adapter.

## How it works (and why)

`ideate-core` is a small **evidence-based** pipeline that **diverges then
converges** — independent multi-agent generation, blind→pool build-on rounds,
embedding dedup + clustering + split novelty/feasibility selection, and an
optional Delphi-style evaluate→regenerate loop.

The full rationale lives in one place: **[docs/ideation-method.md](docs/ideation-method.md)**
is the single source of truth for *why* the engine is shaped this way — every
design decision and default justified by a cited finding (author + year + URL),
plus a "defaults & their evidence" table. Start there.

**Honesty note:** synthetic ideation is a **drafting aid, not a substitute for
real customer discovery** — treat its shortlist as hypotheses to test with people,
not answers.

## Status

Extracted from an internal Kromatic ideation engine, now open source (Apache-2.0) and published to public npm. The configurable multi-agent engine (independent generators + blind→pool build-on rounds, nominal-group / brainwriting style), the divergent→convergent selection half, and the generate→evaluate→regenerate feedback loop are all implemented (feature-complete) — see the method doc above.

**Stability:** `ideate-core` is **pre-1.0 (0.x)** — feature-complete, but the public API may still change before 1.0 (per the [versioning convention](CHANGELOG.md#versioning-convention): while the major version is `0`, a `0.x.0` minor may carry breaking changes). See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md); the exact published version is shown by the npm badge above.
