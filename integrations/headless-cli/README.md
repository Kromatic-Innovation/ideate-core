# headless-CLI invoker adapter

An **optional, example** integration for `ideate-core` — **not** a core
dependency. It supplies the `complete(req) => { ok, text }` function the engine
injects (`deps.complete`) by shelling out to a locally-installed, locally-**authenticated**
headless [Claude Code](https://claude.com/claude-code) CLI session
(`claude -p --output-format json`) instead of a metered API key.

Any Claude Code user can therefore run ideation on their **existing session auth**
with no second credential. `ideate-core` has no import-time dependency on this
file or on the `claude` CLI — this is one interchangeable adapter alongside the
[subagent-dispatch adapter](../subagent-dispatch/README.md) and any HTTP client
you bring yourself.

## Use it as a library

```js
import { ideateCore } from "ideate-core";
import {
  createHeadlessCliComplete,
  assertHeadlessCliAvailable,
} from "ideate-core/integrations/headless-cli";

// 1) Preflight LOUDLY before the engine runs (see "Failing loudly" below).
await assertHeadlessCliAvailable(); // throws if `claude` is missing/unauthenticated

// 2) Build the injectable client and run.
const complete = createHeadlessCliComplete(); // defaults to `claude -p --output-format json`
const { candidates } = await ideateCore(
  { context: { slug: "launch", brief: "ways to promote a product launch" } },
  { complete, buildRound1Prompt: myPromptBuilder },
);
```

`createHeadlessCliComplete(options)` accepts `{ command, args, spawn, timeoutMs,
cwd, env, extractText }` — override `command`/`args` to point at a different
headless CLI, or `extractText` to parse a different output envelope. `spawn` is
injectable so your own tests can stay hermetic.

## Use it from the CLI (`--adapter`)

`adapter.example.mjs` is a ready-to-run adapter exporting `deps = { complete,
buildRound1Prompt }`:

```bash
echo '{"context":{"slug":"launch","brief":"ways to promote a product launch"}}' \
  | node bin/ideate.mjs --adapter ./integrations/headless-cli/adapter.example.mjs
```

Importing that module runs the loud preflight automatically, so the command exits
**non-zero with a clear message** when the CLI is missing or unauthenticated. Set
`IDEATE_HEADLESS_SKIP_PREFLIGHT=1` to skip it. `buildRound1Prompt` there is a
generic placeholder — copy the file and replace it with a domain-specific builder.

## Failing loudly (never a silent empty pool)

The adapter contract requires that a missing/unauthenticated CLI is a **loud,
non-zero failure — never a silently empty candidate pool**. Two things matter:

- `createHeadlessCliComplete()`'s `complete()` **throws** (`HeadlessCliError`) on
  a missing binary (`ENOENT`), a non-zero exit, a timeout, an `is_error:true`
  envelope, or unparseable output — it never returns `{ ok: true }` with empty
  text.
- **`ideate-core`'s engine deliberately swallows a per-agent `complete()` throw**
  (one bad model reply must not sink a whole run) and drops that agent. So if the
  CLI is *entirely* absent, every agent throws and you would get `candidates: []`
  with no error. **Preflight with `assertHeadlessCliAvailable()` before
  `ideateCore()`** — it probes `claude --version` *outside* the engine's swallow
  and throws loudly. `adapter.example.mjs` does this at import time.

## Tests

Hermetic — `child_process.spawn` is injected with a scripted fake, so the suite
needs no real `claude` CLI, subprocess, or network. Run with the repo's
`npm test` (`node --test`, recursive discovery).
