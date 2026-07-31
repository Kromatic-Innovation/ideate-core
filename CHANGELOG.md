# Changelog

All notable changes to `ideate-core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning convention

`ideate-core` is **pre-1.0 (0.x)**. Per semver, while the major version is `0`
the API is not yet stable: a **minor** bump (`0.x.0`) may carry breaking changes,
and a **patch** bump (`0.x.y`) is reserved for backward-compatible fixes. Breaking
changes are called out under a `### Changed` / `### Removed` heading. The public
API surface is the documented `ideateCore` return shape and the `./converge` /
`./feedback` exports.

Each release is cut by tagging `vX.Y.Z` (matching `package.json`), which triggers
the [release workflow](.github/workflows/release.yml) to publish to public npm.

## [Unreleased]

### Deprecated

- **`panelistToFeedback` will be removed in `0.4.0` (#96).** The alias (deprecated
  since `0.2.0`, preserving the `0.1.0` export name for
  `import { panelistToFeedback } from "ideate-core/feedback"`) now has a named
  removal version instead of an open-ended "future minor". Migrate to
  `exampleAdapterFromPanelist` — the two are identical. `0.4.0` is the next minor,
  and pre-1.0 minors may drop a deprecated export (see the versioning convention
  above). The alias remains fully functional and tested until then.

### Chore

- **Synced `package-lock.json` to `0.3.1` and added a CI version-match assertion (#93).**
  The lockfile was left at `0.3.0` when `0.3.1` bumped `package.json`. `npm ci`
  tolerates a root-version mismatch so the release path was not blocked, but the
  lockfile is a provenance artifact and a stale one hides any future desync. CI
  now fails if `package.json` and `package-lock.json` versions diverge, and the
  `CONTRIBUTING.md` release procedure gains the `npm install --package-lock-only`
  step.

### Added

- **Regeneration runs concurrently; convergence complexity documented (#98).**
  `regenerateOne`'s caller awaited one model call per flagged idea (sequential),
  while every other multi-call path is concurrent — a 15-flagged-idea round was
  ~15 serial round-trips per feedback round. It now mirrors round 1's `Promise.all`
  with stable output ordering and the same never-lose-a-flagged-idea semantics;
  concurrency is unbounded by default (like round 1), with an optional
  `deps.regenConcurrency` cap for rate-limited providers (no default cap — that
  would be an unmeasured guess). Separately, `convergePool`'s JSDoc now documents
  each path's complexity (`semanticDedupe`/`scoreAxes`/`poolDiversity` O(n²);
  `clusterByEmbedding` O(n·k) for `k:"auto"` vs O(n³) for a fixed numeric `k`) so
  callers can choose `k:"auto"` for large pools.
- **Formatter check in CI (#97).** Per the maintainer decision, added a
  format-check-only step (Prettier, default rules + `printWidth: 100` to match the
  existing style — no opinionated lint rules). `npm run format` / `npm run
  format:check` scripts, a `prettier` **dev**-dependency (the library still ships
  zero runtime deps), and CI runs `format:check` alongside `node --test`. This
  commit establishes the formatting baseline (formatting-only, no behavioural
  change) so an outside contributor has a mechanical style target.
- **Agent failure counters — the silent-empty-pool is now observable (#90).**
  Every per-agent client failure (network, auth, rate limit, malformed reply,
  missing binary) becomes `null` then zero candidates for that agent, and an
  all-failed run resolved successfully with `candidates: []` — no error, no
  counter. `meta` now reports `agentsAttempted` and `agentsFailed` (round-1
  panel), and `ideateCore` accepts an optional `deps.onAgentError(err, {agentId,
  round})` callback. `runFeedbackLoop` gains `feedback.evaluatorFailures` and a
  `deps.onEvaluatorError` callback so a **thrown** evaluator is distinguishable
  from a satisfied one (the `safeEvaluate` gap). The per-agent no-throw
  robustness contract is unchanged — these only surface what was already being
  swallowed.
- **Adapter-side strip-and-warn for rejected sampling params (#89).** Current
  Anthropic frontier models (Opus 5, Sonnet 5, Opus 4.8/4.7, Fable 5) reject
  `temperature` / `top_p` / `top_k` with HTTP 400; Haiku 4.5 still accepts them.
  Because the engine swallows per-agent throws, a default-panel run against a
  rejecting model previously produced `candidates: []` with no error — the
  silent-empty-pool bug. New `integrations/sampling-params.mjs`
  (`withSamplingParamStrip`, `modelAcceptsSamplingParams`) strips a rejected
  sampling param before the call and warns **once per (model, param)**; both
  example adapters now wire it in. The **core is unchanged** — it keeps sending
  `temperature`, so no model allowlist enters `lib/` and the injectable-client
  design is preserved. `docs/ideation-method.md` and the README no longer present
  temperature as universally available.

### Fixed

- **Agent id de-collision could still collide with an explicit name (#95).**
  The de-collision loop registered only the **base** id in `seen`, so a panel
  like `[{persona:"a"},{persona:"a"},{id:"a-2"}]` generated `a-2` for the second
  agent AND accepted an explicitly-named `a-2` for the third — reproduced as
  `["a","a-2","a-2"]`, the same silent-candidate-loss consequence as the primary
  ID bug (#87). Every assigned id is now registered and the suffix loop increments
  until it finds a genuinely free id, yielding `["a","a-2","a-2-2"]`.
- **Regeneration bypassed `deps.maxTokens` and the agent's temperature (#92).**
  `regenerateOne` hardcoded `temperature: 0.7` / `maxTokens: 2048`, ignoring the
  `deps.maxTokens` honored on every other model path and flattening every
  persona's tuned temperature — so a caller who lowered `maxTokens` for cost
  control silently got 4× the budget on every (unbounded) regeneration, and the
  per-agent temperature diversity lever was erased exactly when rescuing a
  flagged idea. Regen now threads `deps.maxTokens` and recovers the originating
  agent's **numeric** temperature by resolving it from `resolveAgents(deps)` via
  `original.agentId` (sound now that ids are unambiguous, #87), keeping `0.7` /
  `2048` only as fallbacks. The candidate's own `temperature` field (the persona
  **label**, a string) is never forwarded as a sampling temperature.
- **`meta` reported configured rounds and a misleading `ideasPerAgent` scalar (#91).**
  `meta.maxRounds` / `meta.sharing` reflected the *configured* round count, so a
  run with no `buildRound2Prompt` (only round 1 executes) still reported
  `sharing: ["blind","pool"]` — recording a brainwriting round that never ran, in
  the very field that asserts real brainwriting occurred. `meta` now adds
  `roundsRun` (executed) and `sharing` reflects it (`["blind"]` for a one-round
  run); `maxRounds` still reports the configured value. Separately,
  `meta.ideasPerAgent` reported only `agents[0]`'s value as though it were the
  panel's; it is now the scalar only when uniform (else `null`), with the true
  per-agent distribution in `meta.ideasPerAgentByAgent`.
- **CLI crashed at module load on any path containing a space (#88).**
  `bin/ideate.mjs` derived the package.json path from `new URL(import.meta.url).pathname`,
  which is percent-encoded — a space became `%20`, which `readFileSync` cannot
  open — so `npx ideate` (the README's advertised zero-setup smoke test) died at
  module load on any path with a space, including `--help` and `--version`.
  `.pathname` also mangles Windows drive letters, UNC paths, and non-ASCII paths.
  Now uses `fileURLToPath(import.meta.url)`. Adds `bin/ideate.test.mjs` (the CLI
  had no test) which runs the binary from a directory whose name contains a space.
- **Candidate ID collision when two agents share a persona (#87).** `defaultMakeId`
  keyed candidate ids on the agent's **persona label** (`ctx.temperature`) instead
  of its **agent id**. `resolveAgents` already de-collides a shared persona into
  distinct ids (`pragmatist` / `pragmatist-2`), but the id generator discarded
  that, so any panel that repeated a persona — `agentCount > 5` (the default panel
  wraps) or an explicit `deps.agents` array repeating a persona — produced
  colliding candidate ids. The downstream `byId` maps in `feedback`/`converge`
  then **silently dropped** the collided candidates (a 7-agent run could enter the
  feedback loop with 7 ideas and leave with 5). Ids now key on `agentId`. This
  changes the id **format** for the previously-colliding case (the human path,
  `agentId: "human"`, is unchanged).

## [0.3.1] - 2026-07-24

Release-pipeline verification patch. **No source, API, or behavioural changes** —
the published tarball is byte-identical to `0.3.0`. The only commit since that
tag touches `.github/workflows/scorecard.yml`, which does not ship.

This release exists to prove the automated npm **trusted-publishing** path
works, which it never has. This package's npm Trusted Publisher declared an
`Environment name` of `main` while `release.yml` declares no `environment:`, so
the OIDC token carried no environment claim; the mismatch made npm reject the
publish and surfaced as an opaque `404 PUT` rather than an auth error. `0.3.0`
was published manually as a result. With the Trusted Publisher corrected to a
blank environment, a version bump is the only way to verify — npm refuses to
re-publish an existing version.

### Fixed

- **Changelog accuracy.** Two defects corrected in this release:
  - `0.2.0` was headed `- Unreleased` despite having been tagged `v0.2.0` and
    published to npm on 2026-07-21. Now dated.
  - **`0.3.0` had no entry at all** — it was tagged and published on 2026-07-23
    with its public API additions undocumented here. Reconstructed below from
    the commit range `v0.2.0..v0.3.0`.

### Chore

- CI only, nothing shipped: trigger Scorecard on `develop` (the default branch)
  rather than `main`.

### Note

The proposal to replace this repo's inline `release.yml` with a shared
cross-repo reusable workflow was **withdrawn** (#66): a public repo cannot call
a reusable workflow hosted in a private one, so it could never execute. The
shared-template goal moves to a sync-and-drift-check model
(code-workspace-config#1559), leaving this repo's working inline workflow in
place.

## [0.3.0] - 2026-07-23

> **Reconstructed retroactively in `0.3.1`.** This release was tagged and
> published to npm without a changelog entry; the content below is derived from
> the `v0.2.0..v0.3.0` commit range.

Minor bump: adds two new public `integrations/*` subpath exports and ships an
adapter-authoring skill inside the package.

### Added

- **`./integrations/headless-cli`** — headless-CLI invoker adapter, using
  session auth rather than a metered API key.
- **`./integrations/subagent-dispatch`** — subagent-dispatch invoker adapter
  (per-persona round-1 generation).
- **Adapter-authoring skill** bundled in `skills/`, shipped with the package, so
  consumers can write their own invoker adapters.

### Chore

- Adopted the canonical Internal Platform `promote-main.yml`.
- Committed `package-lock.json` for reproducible `npm ci` in CI.
- Gitignored the generated `.agents/`, `.codex/`, and `.zenodotus/` directories
  (cwc#369, #65).
- Pinned the release workflow to the `npm@11` line for OIDC trusted publishing,
  mirroring tickle-stick (#64). Supersedes two earlier incorrect attempts: an
  `NPM_TOKEN` fallback (#63) and a Node 24 bump (#62), both aimed at the same
  `404` that was in fact the Trusted Publisher environment mismatch described
  under `0.3.1`.

## [0.2.0] - 2026-07-21

> **This was a _minor_ bump (0.2.0), not a patch.** Per the versioning
> convention above, a `0.x.0` minor may carry breaking changes — and this cycle
> did: #46 removed the `deps.temperatures` back-compat path and its exported
> constants, which is breaking against the published `0.1.0` artifact.
>
> The docs-only changes previously staged under a dated `[0.1.1] - 2026-07-20`
> heading are folded in below: **no `v0.1.1` tag was ever cut and only `0.1.0`
> is on the registry**, so that entry claimed a release that never shipped.
> Those changes ship with `0.2.0`.

### Chore

- **Packaging** (#47) — exclude `docs/assets/hero.png` (~1.5 MB) from the
  published npm tarball via `package.json` `files`. The hero image renders on the
  GitHub README from the git-hosted path and has no runtime purpose for an npm
  consumer; dropping it shrinks the tarball from ~1.3 MB to ~31 kB (the package
  markets itself as zero-dependency). No effect on the README image on GitHub.

### Removed

- **Legacy temperature-stance panel** (#46) — dropped the pre-S1
  `deps.temperatures` back-compat path and its exported constants
  (`DEFAULT_TEMPERATURES`, `DEFAULT_TEMPERATURE_STANCE`) plus the internal
  temperature-derived agent panel in `resolveAgents`. There is no pre-1.0 public
  release for it to be compatible with, so it was dead scaffolding; use the
  supported `deps.agents` panel (or the default persona panel) instead. Breaking
  only for a caller that passed `deps.temperatures`, which no first-release
  consumer can have.

### Changed

- **`./feedback` export renamed** (#48) — the worked-example adapter exported as
  `panelistToFeedback` in `0.1.0` is now `exampleAdapterFromPanelist`, to signal
  it is an illustrative example rather than a required API. A **deprecated
  back-compat alias** (`export const panelistToFeedback = exampleAdapterFromPanelist`)
  is kept for one release so a `0.1.0` consumer's import keeps working; it will
  be removed in a future minor. Import `exampleAdapterFromPanelist` going forward.
- **Security docs** (#45, docs only) — `SECURITY.md` now calls out the CLI
  `--adapter` flag as a local code-execution surface (it `import()`s and executes
  the module path you give it), and the README states explicitly that
  `input.context` shape-validation is the calling adapter's responsibility, not the
  engine's.
- **Docs hygiene** (#44, docs only) — split the `[0.1.0]` changelog so engine
  features (`### Added`) and packaging/CI (`### Infra`/`### Chore`) read
  separately; added a release rollback/yank pointer to
  [`CONTRIBUTING.md`](CONTRIBUTING.md) (`npm deprecate`, with the 72-hour
  unpublish caveat); and deduped the why/evidence narrative so the README's
  "How it works" is a short pointer and [`docs/ideation-method.md`](docs/ideation-method.md)
  is the single source of truth.
- **README** — polished per the zenodotus gate re-run (#38, docs only): tightened
  the top-of-file preamble (folded the redundant "Why" paragraph into the
  differentiator), added a bibliography pointer to
  [`docs/ideation-method.md`](docs/ideation-method.md#references) where the research
  claims first appear, and reframed the "Status" section as **feature-complete but
  pre-1.0 (0.x)** with the API-stability caveat surfaced inline.
- **README** — added the hero illustration and the use-case / differentiator /
  WHY framing, and corrected the stale "private for now" status line to reflect
  the public Apache-2.0 / public-npm release. (docs only.)

### Fixed

- **NOTICE** copyright year corrected to 2026 to match `LICENSE` and the repo's
  publish year. (#38)
- **README Quick Start** now documents the two contractual shapes a first
  integration silently trips on: `complete(req)` must resolve to
  `{ ok: true, text: string }`, and each model-returned candidate must be
  `{ text: "..." }` (not `{ title, body }`). Getting either wrong is dropped
  silently (`candidates: []`, no error), so the shapes are now shown inline in
  the snippet with a prerequisite callout. (#30)

## [0.1.0] - 2026-07-20

### Added

- **Independent multi-agent round 1** (S1) — N independent generator agents
  (default 5) with per-agent persona / model-provider / temperature / prompt
  strategy; a cross-provider client resolver; `ideasPerAgent`.
- **Configurable sharing policy** (S2) — `rounds[].sharing` (blind→pool),
  mandatory dedupe-before-share, `buildOnDirective`, `incubation`, `maxRounds`.
- **Convergence** (S3, `./converge`) — embedding-cosine dedup, clustering
  (k auto), split novelty/feasibility selection, cross-cluster shortlist,
  human-rerank hook, diversity metric.
- **Evaluate→regenerate feedback loop** (S4, `./feedback`) — Delphi-style
  controlled feedback with a per-idea feedback-in contract and a panelist adapter.
- **Research-backed method doc** (S5) — `docs/ideation-method.md` with cited
  rationale + a defaults→evidence table.

### Infra

Packaging & release infrastructure (no engine behavior):

- **OSS-readiness** — community health files, security workflows (TruffleHog,
  Scorecard, Dependabot, dependency-review; pinned SHAs), complete packaging.
- **Release workflow** — public npm publish on a `v*` tag with provenance.

### Chore

- Routine GitHub Actions dependency bumps via Dependabot (`8e45570`, `5176681`,
  `1ec8072`, `d92fd94`, `fe05196`, `391ae3a`).

[0.3.1]: https://github.com/Kromatic-Innovation/ideate-core/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kromatic-Innovation/ideate-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kromatic-Innovation/ideate-core/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kromatic-Innovation/ideate-core/releases/tag/v0.1.0
