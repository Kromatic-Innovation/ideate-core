# Contributing to ideate-core

Thanks for your interest! `ideate-core` is a small, zero-dependency ESM library
with a deliberately narrow scope: a provider-agnostic ideation primitive
(independent multi-agent generation → blind→pool build-on rounds → convergence →
optional evaluate→regenerate). Please read
[`docs/ideation-method.md`](docs/ideation-method.md) before proposing changes to
the method — the design is evidence-based and each default is cited.

## Ground rules

- **Zero runtime dependencies.** The library must stay dependency-free. Model
  clients, embedders, and evaluators are *injected*, never imported.
- **Offline tests only.** Every test injects mock clients — no network, no
  secrets, no live model calls. Run them with `npm test` (`node --test`).
- **Robustness over strictness.** The engine must never throw on messy model
  output; it drops malformed candidates instead.
- **Keep scope tight.** Domain-specific prompt copy and fields belong in the
  caller's adapter, not in the core.

## Development

```bash
git clone https://github.com/Kromatic-Innovation/ideate-core.git
cd ideate-core
npm test            # node --test lib/*.test.mjs
```

Requires Node.js >= 20.

## Pull requests

1. Branch from `develop`.
2. Add or update offline tests for any behavior change.
3. Keep the public API and the documented candidate shape stable (this is a
   pre-1.0 library; breaking changes need a clear rationale and a semver bump).
4. Ensure `npm test` is green and `npm pack --dry-run` is clean.
5. Open the PR against `develop`; describe the change and link any issue.

## Reporting bugs / requesting features

Use the issue templates. For anything security-sensitive, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license.
