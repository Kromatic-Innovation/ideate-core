# The ideate-core method (and why)

`ideate-core` is not "ask a model for ideas." It is a small, evidence-based
pipeline that mirrors what six decades of human-creativity research — and the
recent LLM-ideation literature — say actually produces **novel** ideas rather
than a homogenized average. This document states each design decision and the
finding that justifies it. Every claim carries a citation with a URL; the
[references](#references) list is at the bottom.

The honest caveat first: **synthetic ideation is a drafting aid, not a
substitute for real customer discovery.** The pipeline widens and sharpens the
option space; it does not tell you what is true about your market. Treat its
shortlist as hypotheses to test with people, not answers.

---

## The shape: diverge, then converge

Creativity research treats idea work as two distinct phases — **divergence**
(generate many, varied options) then **convergence** (dedupe, cluster, select the
few worth pursuing). Collapsing them is the classic failure mode: an LLM asked
for "the best idea" skips straight to convergence and returns the safe average.
`ideate-core` keeps the phases separate and does each deliberately.

```
 DIVERGE ─────────────────────────────▶ CONVERGE ──────────▶ (optional) VET
 independent multi-agent round 1        embedding dedup        evaluate → regen
 → blind→pool build-on rounds           → cluster → split-axis  (Delphi loop)
 → human ideas folded in                → shortlist → human rerank
```

---

## 1. Independent multi-agent round 1 (not one call, not a debate)

**Decision.** Round 1 runs **N independent generator agents** (default 5). Each
is a *separate* model call with *no shared context* (`independence: "blind"`).

**Why.** The most robust finding in group-creativity research is that **nominal
groups** — individuals working independently, pooled afterward — generate more
and better ideas than interacting groups, which suffer production blocking,
evaluation apprehension, and conformity (Taylor, Berry & Block 1958; Diehl &
Stroebe 1987; meta-analytic confirmation in Mullen, Johnson & Salas 1991). The
LLM analog is direct: independent generations avoid the mode-collapse that a
single shared context produces (Si et al. 2024), and generative AI *increases*
individual novelty while *reducing* the collective diversity of content when
everyone shares the same context (Doshi & Hauser 2024). Independence is the
anti-mode-collapse core.

## 2. Engineered diversity: persona, provider, temperature, strategy

**Decision.** Diversity is produced by **explicit per-agent levers**, not by
asking for it. The default panel gives each agent a distinct **persona**
(pragmatist / contrarian / domain-expert / outsider-analogy / visionary), its own
**temperature**, and a **prompt strategy** (chain-of-thought by default).

**Why.** "Be diverse" in the prompt barely moves idea variance; *structural*
levers do (Meincke, Mollick & Terwiesch 2024). Assigning distinct **personas**
is a strong, reliable diversity lever — stronger than temperature alone — and
multi-persona collaboration measurably broadens the solution space (Wang et al.
2023). Chain-of-thought prompting yields the highest idea variance of the
strategies tested (Meincke et al. 2024).

## 3. Cross-provider panel

**Decision.** Each agent can be routed to a **different provider/model** (an
injected `clients` map or `resolveClient` resolver — Anthropic + OpenAI +
xAI/Grok + …). No vendor SDK is baked in; the client is injectable and the
default throws.

**Why.** A single model has a single latent style; a heterogeneous panel gives
real between-model variance instead of one model's mode. It also sidesteps
**self-preference bias** — models rate their own outputs more highly — which
matters as soon as an LLM is also used to judge (Wataoka et al. 2024).

## 4. Quantity in round 1

**Decision.** `ideasPerAgent` defaults to **6**; defer judgment and push volume
in divergence.

**Why.** Idea quantity and quality are strongly correlated (r ≈ .82); more ideas
reliably yields more *good* ideas, and withholding evaluation during generation
raises output (Diehl & Stroebe 1987). Convergence — not round 1 — is where you
prune.

## 5. Build-on rounds share the **deduped** pool (brainwriting), not each agent's own seeds

**Decision.** Round 1 is blind. Build-on rounds (2+) default to **pool** sharing:
each agent builds on the **shared, deduped** pool. Dedupe-before-share is
**mandatory** for pool rounds. A `buildOnDirective` tells agents to
combine/extend/subvert into new directions, not restate, and `incubation`
provides fresh context between rounds.

**Why.** This is real **brainwriting / 6-3-5** (Rohrbach 1968; Paulus & Yang
2000): building on *others'* ideas is where cross-stimulation happens. But the
benefit is **conditional** — sharing a *raw* pool triggers **collaborative
fixation**, where exposure to others' ideas narrows rather than widens the
search (Kohn & Smith 2011), and LLM pools homogenize fast (Si et al. 2024). So
we share only the **deduped** pool, and we instruct genuine building-on, because
cognitive stimulation only helps when it is actually stimulation and not
imitation (Dugosh et al. 2000; Nijstad & Stroebe's SIAM model, 2006). A fresh
**incubation** context between rounds counteracts the variety decline that
continuous exposure produces (Sio & Ormerod 2009; Kohn & Smith 2011).

## 6. Convergence: semantic dedup → cluster → split-axis selection → human rerank

**Decision.** Convergence embeds candidates and:
- **dedupes by embedding cosine** (default threshold 0.83), not just normalized text;
- **clusters** (k auto) so selection samples *across* themes;
- scores **novelty and feasibility on separate axes** — never collapsed to one "best";
- builds a **cross-cluster shortlist** and hands the top-N to a **human rerank** hook;
- reports a **diversity metric** against an optional floor.

**Why.**
- *Semantic dedup:* naive LLM pools are ~95% near-duplicate, and a text key
  misses semantic duplicates (Si et al. 2024) — you must dedupe in embedding
  space to see them.
- *Clustering:* sampling across clusters counters the collective-diversity
  collapse (Doshi & Hauser 2024) by forcing selection to span modes.
- *Split axes:* when people (or models) pick a single "best" idea they reliably
  choose the **feasible** over the **original**, quietly killing novelty
  (Rietzschel, Nijstad & Stroebe 2010). Keeping novelty and feasibility on
  separate axes prevents that collapse.
- *Human rerank:* an LLM judge correlates weakly with human novelty judgments and
  is best used as a **filter**, not a novelty ranker (Zheng et al. 2023);
  human rerank of a strong shortlist is what actually lifted idea quality (Si et
  al. 2024).
- *Diversity metric:* measure diversity, don't assume it (Meincke et al. 2024).

## 7. Evaluate → regenerate (a Delphi-style controlled-feedback loop)

**Decision.** An optional loop: an **external evaluator** (different model from
the generators) critiques the pool with a per-idea contract
(`keep` / `revise` / `kill`, split-axis `scores`, `dealKillers`, `keepReasons`);
the engine runs a **targeted regeneration** of only the flagged ideas against
their specific critique, then re-dedupes and re-clusters.

**Why.** This is the **Delphi method** — iterated, *controlled* feedback between
rounds — which improves group judgment over one-shot elicitation (Dalkey &
Helmer 1963; Rowe & Wright 1999). Targeting regeneration to the specific
`dealKillers`/`keepReasons` is what makes the second pass better rather than just
different. The evaluator must be a **different model** from the generators to
avoid self-preference bias (Wataoka et al. 2024). Kromatic's `plenum` is the
intended first evaluator; the engine ships an adapter for its shipped deal-killer
contract but stays evaluator-agnostic.

---

## Defaults & their evidence

| Default | Value | The finding that justifies it |
| --- | --- | --- |
| `agentCount` | 5 independent agents | Nominal groups beat interacting groups (Taylor 1958; Diehl & Stroebe 1987; Mullen 1991) |
| `independence` | `"blind"` (no shared context in round 1) | Shared context ⇒ mode collapse / diversity loss (Si et al. 2024; Doshi & Hauser 2024) |
| default personas | pragmatist / contrarian / domain-expert / outsider-analogy / visionary | Persona is a strong, reliable diversity lever (Wang et al. 2023; Meincke et al. 2024) |
| per-agent `strategy` | chain-of-thought (most agents) | CoT gives the highest idea variance (Meincke et al. 2024) |
| per-agent `model` | cross-provider panel supported | Heterogeneous models add variance + sidestep self-preference (Wataoka et al. 2024) |
| `ideasPerAgent` | 6 | Quantity↔quality r ≈ .82; defer judgment (Diehl & Stroebe 1987) |
| round-2+ `sharing` | `"pool"` | Brainwriting: build on others' ideas (Rohrbach 1968; Paulus & Yang 2000) |
| `dedupeBeforeShare` | mandatory for pool | Raw-pool sharing ⇒ fixation + homogenization (Kohn & Smith 2011; Si et al. 2024) |
| `incubation` | on for build-on rounds | Incubation counteracts variety decline (Sio & Ormerod 2009) |
| `maxRounds` | 2 | Each round is one pool→build-on cycle |
| `convergence.dedupe.threshold` | 0.83 cosine | Text dedup misses semantic dups; pools ~95% duplicate (Si et al. 2024) |
| `convergence.cluster.k` | auto | Sample across themes to counter diversity collapse (Doshi & Hauser 2024) |
| selection scores | novelty ⟂ feasibility (separate) | Single-"best" selection kills novelty (Rietzschel et al. 2010) |
| human-rerank hook | on the top-N | LLM judge is a filter, not a novelty ranker (Zheng et al. 2023; Si et al. 2024) |
| `feedbackLoop.maxRegenRounds` | 2 | Delphi controlled feedback improves judgment (Dalkey & Helmer 1963; Rowe & Wright 1999) |
| `feedbackLoop.evaluator.model` | must differ from generators | Self-preference bias (Wataoka et al. 2024) |

---

## References

- Taylor, D. W., Berry, P. C., & Block, C. H. (1958). *Does group participation when using brainstorming facilitate or inhibit creative thinking?* Administrative Science Quarterly. https://doi.org/10.2307/2390603
- Dalkey, N., & Helmer, O. (1963). *An experimental application of the Delphi method to the use of experts.* Management Science. https://doi.org/10.1287/mnsc.9.3.458
- Rohrbach, B. (1968). *Kreativ nach Regeln — Methode 635, eine neue Technik zum Lösen von Problemen* (Method 635 / 6-3-5 brainwriting). Absatzwirtschaft. https://en.wikipedia.org/wiki/6-3-5_Brainwriting
- Diehl, M., & Stroebe, W. (1987). *Productivity loss in brainstorming groups: Toward the solution of a riddle.* Journal of Personality and Social Psychology. https://doi.org/10.1037/0022-3514.53.3.497
- Mullen, B., Johnson, C., & Salas, E. (1991). *Productivity loss in brainstorming groups: A meta-analytic integration.* Basic and Applied Social Psychology. https://doi.org/10.1207/s15324834basp1201_1
- Rowe, G., & Wright, G. (1999). *The Delphi technique as a forecasting tool: issues and analysis.* International Journal of Forecasting. https://doi.org/10.1016/S0169-2070(99)00018-7
- Dugosh, K. L., Paulus, P. B., Roland, E. J., & Yang, H.-C. (2000). *Cognitive stimulation in brainstorming.* Journal of Personality and Social Psychology. https://doi.org/10.1037/0022-3514.79.5.722
- Paulus, P. B., & Yang, H.-C. (2000). *Idea generation in groups: A basis for creativity in organizations.* Organizational Behavior and Human Decision Processes. https://doi.org/10.1006/obhd.1999.2888
- Nijstad, B. A., & Stroebe, W. (2006). *How the group affects the mind: A cognitive model of idea generation in groups (SIAM).* Personality and Social Psychology Review. https://doi.org/10.1207/s15327957pspr1003_1
- Sio, U. N., & Ormerod, T. C. (2009). *Does incubation enhance problem solving? A meta-analytic review.* Psychological Bulletin. https://doi.org/10.1037/a0014212
- Rietzschel, E. F., Nijstad, B. A., & Stroebe, W. (2010). *The selection of creative ideas after individual idea generation: Choosing between creativity and impact.* British Journal of Psychology. https://doi.org/10.1348/000712609X414204
- Kohn, N. W., & Smith, S. M. (2011). *Collaborative fixation: Effects of others' ideas on brainstorming.* Applied Cognitive Psychology. https://doi.org/10.1002/acp.1699
- Zheng, L., Chiang, W.-L., Sheng, Y., et al. (2023). *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* arXiv. https://arxiv.org/abs/2306.05685
- Wang, Z., Mao, S., Wu, W., et al. (2023). *Unleashing the emergent cognitive synergy in LLMs: A task-solving agent through multi-persona self-collaboration.* arXiv. https://arxiv.org/abs/2307.05300
- Meincke, L., Mollick, E., & Terwiesch, C. (2024). *Prompting diverse ideas: Increasing AI idea variance.* arXiv. https://arxiv.org/abs/2402.01727
- Doshi, A. R., & Hauser, O. P. (2024). *Generative AI enhances individual creativity but reduces the collective diversity of novel content.* Science Advances. https://doi.org/10.1126/sciadv.adn5290
- Si, C., Yang, D., & Hashimoto, T. (2024). *Can LLMs generate novel research ideas? A large-scale human study with 100+ NLP researchers.* arXiv. https://arxiv.org/abs/2409.04109
- Wataoka, K., Takahashi, T., & Ri, R. (2024). *Self-preference bias in LLM-as-a-judge.* arXiv. https://arxiv.org/abs/2410.21819

> A note on the citations: these are the primary sources behind each decision.
> Where a claim rests on a broad literature rather than one paper (e.g. "nominal
> groups beat interacting groups"), the strongest representative + a meta-analysis
> are cited. This doc is versioned with the code so a design change and its
> evidence move together.
