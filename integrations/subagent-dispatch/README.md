# subagent-dispatch invoker adapter

An **optional, example** integration for `ideate-core` — **not** a core
dependency. It supplies the `complete(req) => { ok, text }` function the engine
injects (`deps.complete`) by driving a **host environment's own subagent /
Task-dispatch primitive** — one dispatch call per generator persona.

`ideate-core` has no import-time dependency on this file or on any agent runtime
— this is one interchangeable adapter alongside the
[headless-CLI adapter](../headless-cli/README.md) and any HTTP client you bring
yourself.

## Why it fits round 1

Round 1 of ideate-core's method is explicitly **N independent, blind agents
differentiated by persona** (persona beats temperature — Wang et al. 2023,
Meincke et al. 2024). The engine fires every round-1 persona agent concurrently,
calling `deps.complete(req)` once per agent with that agent's `persona` /
`strategy` / `model` on the request. This adapter forwards each such call
straight to your subagent dispatch, so **"one persona agent" becomes "one
subagent dispatch"**. The sharing / dedup / build-on rounds stay entirely inside
the engine.

## Use it as a library

```js
import { ideateCore } from "ideate-core";
import {
  createSubagentDispatchComplete,
  assertSubagentDispatchAvailable,
} from "ideate-core/integrations/subagent-dispatch";

// `dispatch` is YOUR runtime's Task/subagent primitive: it hands a persona's
// prompt to a subagent and returns its reply text (string, or { text | result |
// output }, or a full { ok, text } envelope).
const dispatch = async (task) => runSubagent({ prompt: task.prompt, label: task.persona });

// 1) Preflight LOUDLY before the engine runs (see "Failing loudly" below).
await assertSubagentDispatchAvailable({ dispatch }); // throws if no capability wired

// 2) Build the injectable client and run.
const complete = createSubagentDispatchComplete({ dispatch });
const { candidates } = await ideateCore(
  { context: { brief: "ways to promote a product launch" } },
  { complete, buildRound1Prompt: myPersonaAwarePromptBuilder },
);
```

`createSubagentDispatchComplete(options)` accepts `{ dispatch, mapRequest,
timeoutMs }`:

- **`dispatch`** (required) — `async (task) => reply`. `task` is
  `mapRequest(req)`; by default that forwards `{ prompt, persona, strategy,
  model, temperature, ideasPerAgent }`.
- **`mapRequest`** — reshape the engine's `req` into whatever your dispatch
  expects (e.g. `{ agentPrompt, subagentType }`).
- **`timeoutMs`** (default `120000`) — reject a dispatch that runs longer than
  this, since your runtime may not enforce its own timeout.

## Use it from the CLI (`--adapter`)

`adapter.example.mjs` is a ready-to-run adapter exporting `deps = { complete,
buildRound1Prompt }`. Because the dispatch primitive is host-specific, point it
at an ESM module of yours that `export const dispatch`:

```bash
IDEATE_SUBAGENT_DISPATCH_MODULE=./my-dispatch.mjs \
echo '{"context":{"brief":"ways to promote a product launch"}}' \
  | node bin/ideate.mjs --adapter ./integrations/subagent-dispatch/adapter.example.mjs
```

Importing that module runs the loud preflight automatically, so the command exits
**non-zero with a clear message** when no dispatch is wired. Set
`IDEATE_SUBAGENT_SKIP_PREFLIGHT=1` to skip it. `buildRound1Prompt` there is a
generic, persona-aware placeholder — copy the file and replace it with a
domain-specific builder.

## Failing loudly (never a silent empty pool)

The adapter contract requires that a missing dispatch capability is a **loud,
non-zero failure — never a silently empty candidate pool**. Two things matter:

- `createSubagentDispatchComplete()` **throws** (`SubagentDispatchError`) at
  **construction** when no `dispatch` function is supplied — a host with no
  subagent-dispatch capability cannot get a silently-degrading adapter. Its
  `complete()` also throws on a dispatch error, an `ok:false` result, an
  unextractable/empty reply, or a timeout — it never returns `{ ok: true }` with
  empty text.
- **`ideate-core`'s engine deliberately swallows a per-agent `complete()` throw**
  (one bad reply must not sink a whole run) and drops that agent. So if the
  dispatch capability is *entirely* absent, every agent throws and you would get
  `candidates: []` with no error. **Preflight with
  `assertSubagentDispatchAvailable({ dispatch })` before `ideateCore()`** — it
  runs *outside* the engine's swallow and throws loudly (pass `probe: true` to
  actually invoke one dispatch). `adapter.example.mjs` does this at import time.

## Tests

Hermetic — the `dispatch` primitive is injected with a scripted fake, so the
suite needs no real agent runtime, Task dispatch, or network. Run with the repo's
`npm test` (`node --test`, recursive discovery).
