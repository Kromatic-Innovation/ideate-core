# Security Policy

## Supported Versions

`ideate-core` is pre-1.0 (0.x). Security fixes are applied to the latest
published `0.x` release.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via GitHub's
[private vulnerability reporting](https://github.com/Kromatic-Innovation/ideate-core/security/advisories/new)
(Security → Report a vulnerability), or email **security@kromatic.com**.

Please include a description of the issue, steps to reproduce, and the affected
version. We aim to acknowledge reports within 5 business days and to provide a
remediation timeline after triage.

## Scope

`ideate-core` has **no runtime dependencies** and performs no network I/O of its
own — all model clients, embedders, and evaluators are injected by the caller.
The most relevant security considerations are therefore:

- **Prompt / output handling** — the engine treats model output as untrusted and
  never `eval`s it; parsing is tolerant and never throws.
- **Injected clients** — the caller is responsible for the security of the model
  clients, API keys, and any network egress they perform.
- **`--adapter` is a local code-execution surface** — the CLI's `--adapter <path>`
  flag does a dynamic `import()` of the module path you give it, which loads and
  **executes** that local JS module in-process. Only point `--adapter` at code you
  trust (your own adapter); it is not a sandbox.
