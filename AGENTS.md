# AGENTS.md — ideate-core

LLM-agnostic agent guidance for this repo.

## What this is

A provider-agnostic ideation primitive — multi-stance divergent generation, an
expansion pass, and human-idea folding, exposed as a zero-dependency injectable
function.

## Branch policy

- Default branch: `develop`; open PRs against `develop`.
- Releases are tagged from `main` after a `develop → main` fast-forward.

## Strategy tier

**T3.** A public, packaged ideation primitive consumed across the fleet.

Band rationale: `code-workspace-config/docs/strategy/portfolio.md`. Canonical
strategy: `code-workspace-config/docs/strategy/README.md`. Strategy is stated in
prose there and nowhere else — do not restate or paraphrase it here.
