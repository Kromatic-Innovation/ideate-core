# ideate-core

**A provider-agnostic ideation _primitive_** — multi-stance divergent generation, an expansion pass, and human-idea folding, as a zero-dependency injectable function. Not a framework, not model-locked: you bring the model client and the prompts.

## What it does

Turns a domain context into a pool of idea candidates by prompting a model across several **stance briefs** (e.g. conservative / normal / wacky), optionally running an **expansion round** over the best of round one, and folding in any **human-supplied ideas** so they ride the same downstream gates.

- **Multi-stance round 1** — one call per stance, so a single stance owns a single call.
- **Expansion round 2** — feeds round-1 seeds back for a refine/combine/extend pass that emits new candidates.
- **Human-idea folding** — caller ideas are normalized into the candidate shape and merged; a near-identical human idea wins the dedup tie.
- **Robust parsing** — tolerates ```json fences, surrounding prose, and `{candidates|ideas|posts:[...]}` wrappers; drops malformed candidates rather than throwing.
- **Global dedup**, injectable `complete` client (tests stay offline), zero domain code.

```js
import { ideateCore } from "@kromatic-innovation/ideate-core";

const { candidates } = await ideateCore({
  context: { slug: "demo", brief: "ways to promote a launch" },
  deps: { complete, buildRound1Prompt /* , buildRound2Prompt, normalizeExtra */ },
});
```

## Status

Early. Extracted from an internal ideation engine (Kromatic-Innovation cwc#1320 S2 / cwc#737). **Private for now, with the intent to open-source once it earns it** — the roadmap is a configurable multi-agent engine (independent generators + a build-on round, nominal-group / brainwriting style) plus a generate→evaluate→regenerate feedback loop. Apache-2.0.
