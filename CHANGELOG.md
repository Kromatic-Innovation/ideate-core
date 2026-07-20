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

### Fixed

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
- **OSS-readiness** — community health files, security workflows (TruffleHog,
  Scorecard, Dependabot, dependency-review; pinned SHAs), complete packaging.
- **Release workflow** — public npm publish on a `v*` tag with provenance.

[Unreleased]: https://github.com/Kromatic-Innovation/ideate-core/compare/v0.1.0...develop
[0.1.0]: https://github.com/Kromatic-Innovation/ideate-core/releases/tag/v0.1.0
