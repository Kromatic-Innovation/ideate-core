# ideate-core

**A provider-agnostic ideation _primitive_** — multi-stance divergent generation, an expansion pass, and human-idea folding, as a zero-dependency injectable function. Not a framework, not model-locked: you bring the model client and the prompts.

## What it does

Turns a domain context into a pool of idea candidates by running a panel of **independent generator agents** (each a separate model call with no shared context — the nominal-group analog), optionally running an **expansion round** over round one, and folding in any **human-supplied ideas** so they ride the same downstream gates.

- **Independent multi-agent round 1** — N agents (default 5), each a separate blind model call. Diversity is _engineered_ via per-agent levers — **persona** (default: pragmatist / contrarian / domain-expert / outsider-analogy / visionary), **temperature**, and **prompt strategy** (chain-of-thought). "Be diverse" alone fails; persona beats temperature as a lever (Wang et al. 2023; Meincke et al. 2024).
- **Cross-provider panel** — route each agent to a different provider/model via an injected `clients` map or `resolveClient` resolver (Anthropic + OpenAI + xAI/Grok + …). No vendor SDK is baked in; heterogeneous models give real variance and sidestep self-preference bias (Wataoka et al. 2024).
- **Expansion round 2** — feeds round-1 seeds back for a refine/combine/extend pass that emits new candidates.
- **Human-idea folding** — caller ideas are normalized into the candidate shape and merged; a near-identical human idea wins the dedup tie.
- **Robust parsing** — tolerates ```json fences, surrounding prose, and `{candidates|ideas|posts:[...]}` wrappers; drops malformed candidates rather than throwing.
- **Global dedup**, provider-agnostic injectable client (tests stay offline), zero domain code.

```js
import { ideateCore } from "@kromatic-innovation/ideate-core";

// Single-client panel (the default 5 personas all route to one client):
const { candidates } = await ideateCore(
  { context: { slug: "demo", brief: "ways to promote a launch" } },
  { complete, buildRound1Prompt /* , buildRound2Prompt, normalizeExtra */ },
);

// Cross-provider panel — one agent per provider:
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

## Status

Early. Extracted from an internal ideation engine (Kromatic-Innovation cwc#1320 S2 / cwc#737). **Private for now, with the intent to open-source once it earns it** — the roadmap is a configurable multi-agent engine (independent generators + a build-on round, nominal-group / brainwriting style) plus a generate→evaluate→regenerate feedback loop. Apache-2.0.
