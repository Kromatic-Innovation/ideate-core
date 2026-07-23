---
name: adapter-authoring
description: Author a custom invoker adapter for ideate-core — implement the complete() / candidate {ok,text} contract that wires the provider-agnostic ideation engine to any model client (HTTP API, local CLI, a host's subagent dispatch, or your own code). Use when integrating ideate-core with a model backend it doesn't ship a client for, or when adapting existing code to the engine's deps contract.
---

# Authoring an ideate-core invoker adapter

`ideate-core` is a **provider-agnostic, zero-dependency** ideation engine. It
ships **no** model client — "bring your own model client" is a deliberate design
property. To run a live ideation you inject a small `deps` object; the one
piece almost every integration needs is an **invoker adapter**: a `complete()`
function that turns a prompt into model text.

This skill teaches you to write that adapter from scratch, and points at the two
reference adapters bundled in [`integrations/`](../../integrations/) as worked
examples.

---

## 1. The contract, in one paragraph

`ideateCore(input, deps)` fires an independent panel of persona agents. For each
agent it builds a prompt (`deps.buildRound1Prompt`) and calls your invoker:

```
deps.complete(req)  →  { ok: true, text: "<the model's reply>" }
```

That is the whole invoker contract. Everything else the engine does — persona
differentiation, blind→pool brainwriting rounds, dedup, clustering, convergence,
the evaluate→regenerate loop — happens **inside** the engine on the `text` your
adapter returns. Your adapter's only job is: **prompt in, reply text out.**

### `req` — what the engine hands your `complete()`

A plain object. The field you must use is `prompt`; the rest are optional routing
hints you may ignore:

| field           | meaning                                                        |
| --------------- | ------------------------------------------------------------- |
| `prompt`        | the fully-built prompt string for this agent (**use this**)   |
| `model`         | the agent's assigned model id, if any                         |
| `temperature`   | the agent's temperature label/value, if set                  |
| `maxTokens`     | per-call token ceiling (default 2048)                          |
| `persona`       | the agent's persona (round 1 differentiates by persona)       |
| `strategy`      | the agent's generation strategy, if set                       |
| `ideasPerAgent` | how many ideas this agent was asked for                       |

### The return value

- **Success:** `{ ok: true, text: "<string>" }`. `text` is the raw model reply;
  the engine parses candidates out of it (see §2). Any extra fields are ignored.
- **Anything else** (`ok` not `true`, or `text` not a string) is treated by the
  engine as "no result from this agent" — see the **loud-failure** rule in §3,
  which is the single most important thing to get right.

`complete` may be `async`. For a **cross-provider panel**, instead of a single
`deps.complete` you may pass `deps.clients` (`{ modelId: complete }`) and/or
`deps.resolveClient` (`modelId => complete`); each agent's `model` routes to the
matching client. Most adapters just implement the single `deps.complete`.

---

## 2. What `text` should contain (the candidate-parsing contract)

By default the engine extracts candidates from your `text` with a tolerant
parser (`extractCandidates`). It accepts, in order of preference:

- a **bare JSON array** — `[{"text":"idea one"}, {"text":"idea two"}]`
- a **```json fenced** block containing that array
- objects shaped `{ "text": "…" }` (a bare array of strings also works)

So the reliable move is to make your **prompt** instruct the model to reply with
*only* a JSON array of `{"text": "..."}` objects, and pass the reply straight
through as `text`. You do **not** parse candidates in the adapter — that is the
engine's job. If your backend needs a different reply shape, override
`deps.parse: (text) => rawCandidate[]` instead of contorting the adapter.

---

## 3. Fail loudly — never a silently empty candidate pool

This is the rule adapters most often get wrong, and every bundled adapter is
built around it.

**The hazard:** `ideateCore` deliberately wraps each per-agent `complete()` call
in a `try/catch` and **drops** an agent whose call throws — so that one bad model
reply cannot sink an entire run. That robustness is correct for the engine. But
it means that if your backend is *entirely* unavailable (CLI not installed, API
key missing, no dispatch capability), **every** agent throws, every agent is
dropped, and the run returns `candidates: []` **with no error** — a silent,
mystifying empty pool.

**The fix — a two-part discipline:**

1. **Your `complete()` throws a clear, typed error** on a real failure (missing
   binary, non-2xx HTTP, timeout, an error envelope, unparseable/empty output) —
   never return `{ ok: true, text: "" }`.
2. **Export a preflight** the caller runs **before** `ideateCore()`, *outside*
   the engine's swallow — a cheap liveness/credential check (`--version`, a HEAD
   request, "is the capability wired?") that throws loudly when the backend is
   absent or unauthenticated. Run it once at startup so failure is immediate and
   legible instead of an empty result 30 seconds later.

Give your error its own class (e.g. `class MyAdapterError extends Error`) so
callers can catch adapter failures apart from generic ones.

---

## 4. A minimal adapter from scratch

A complete, provider-agnostic HTTP adapter — copy and adapt the two marked lines:

```js
// my-adapter.mjs — a minimal ideate-core invoker adapter.

export class MyAdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = "MyAdapterError";
  }
}

// (a) The invoker: prompt in, { ok, text } out. Throws loudly on failure.
export function createComplete({ endpoint, apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new MyAdapterError("createComplete: apiKey is required");
  return async function complete(req = {}) {
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    if (!prompt) throw new MyAdapterError("complete: req.prompt (non-empty string) is required");

    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ prompt, max_tokens: req.maxTokens ?? 2048 }), // (b) your backend's shape
      });
    } catch (err) {
      throw new MyAdapterError(`complete: request failed: ${err.message}`);
    }
    if (!res.ok) throw new MyAdapterError(`complete: backend returned HTTP ${res.status}`);

    const body = await res.json();
    const text = body.reply; // (b) pull the assistant text out of YOUR backend's response
    if (typeof text !== "string" || !text) {
      throw new MyAdapterError("complete: backend returned no text");
    }
    return { ok: true, text };
  };
}

// (c) Preflight: a cheap check the caller runs BEFORE ideateCore(), outside the
// engine's per-agent throw-swallow. Throws loudly if the backend is unreachable.
export async function assertAvailable({ endpoint, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(endpoint, { method: "HEAD" });
  } catch (err) {
    throw new MyAdapterError(`assertAvailable: cannot reach ${endpoint}: ${err.message}`);
  }
  if (!res.ok) throw new MyAdapterError(`assertAvailable: ${endpoint} returned HTTP ${res.status}`);
  return { ok: true };
}
```

Wire it into a run:

```js
import { ideateCore } from "ideate-core";
import { createComplete, assertAvailable } from "./my-adapter.mjs";

await assertAvailable({ endpoint });            // loud preflight
const complete = createComplete({ endpoint, apiKey });
const { candidates } = await ideateCore(
  { context: { brief: "ways to promote a product launch" } },
  {
    complete,
    buildRound1Prompt: ({ context, persona, ideasPerAgent = 6 }) =>
      `You are ${persona}. Generate ${ideasPerAgent} genuinely different ideas ` +
      `for: ${context.brief}\n\nReply with ONLY a JSON array of {"text": "the idea"}.`,
  },
);
```

Note `buildRound1Prompt` is **required** and is *yours* — it is where domain
knowledge and the "reply as a JSON array of `{text}`" instruction live. Keep the
adapter domain-agnostic; keep domain copy in the prompt builder.

---

## 5. Run it from the CLI (`--adapter`)

`bin/ideate.mjs --adapter <module>` loads an ESM module that exports
`deps = { complete, buildRound1Prompt, ... }` (or a default export of that
object) and runs `ideateCore` with it:

```bash
echo '{"context":{"brief":"ways to promote a product launch"}}' \
  | node bin/ideate.mjs --adapter ./my-adapter-deps.mjs
```

Run your loud preflight at that module's import time so `ideate --adapter …`
exits **non-zero** when the backend is missing, rather than printing an empty
pool.

---

## 6. Two worked examples shipped in this package

Both live under [`integrations/`](../../integrations/), are zero-dependency, and
inject their I/O primitive so their tests stay hermetic — read them as templates:

- **[headless-CLI](../../integrations/headless-cli/README.md)** — `complete()`
  shells out to a locally-**authenticated** Claude Code CLI session
  (`claude -p --output-format json`) instead of a metered API key. Shows the
  loud-failure discipline end to end: `createHeadlessCliComplete()` throws on
  `ENOENT` / non-zero exit / timeout / `is_error`, and
  `assertHeadlessCliAvailable()` is the `--version` preflight. `spawn` is
  injectable for hermetic tests.
- **[subagent-dispatch](../../integrations/subagent-dispatch/README.md)** —
  `complete()` forwards each persona agent to a **host's own subagent /
  Task-dispatch** primitive (one dispatch per persona — the natural fit for
  round 1's persona panel). Shows loud failure at *construction*
  (`createSubagentDispatchComplete` throws when no `dispatch` is wired) plus
  `assertSubagentDispatchAvailable()`. The `dispatch` function is injected for
  hermetic tests.

Neither is a core dependency — the engine has no import-time dependency on
either, and your own adapter is equally first-class.

---

## 7. Author's checklist

- [ ] `complete(req)` returns `{ ok: true, text: "<string>" }` on success and
      **throws a typed error** on any real failure — never `{ ok: true, text: "" }`.
- [ ] `req.prompt` is validated; you build your backend request from it.
- [ ] The prompt (via `buildRound1Prompt`) asks for a **JSON array of
      `{"text": "..."}`** — or you supply a matching `deps.parse`.
- [ ] A **preflight** (`assertAvailable`-style) throws loudly *before*
      `ideateCore()`, outside the engine's per-agent swallow.
- [ ] The adapter is **domain-agnostic** and **dependency-light**; I/O primitives
      (fetch/spawn/dispatch) are injectable so tests can be **hermetic** (no real
      network, CLI, or runtime needed to pass).
- [ ] Docs show both library use and `bin/ideate.mjs --adapter` use.
