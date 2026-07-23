// integrations/subagent-dispatch/index.mjs — subagent-dispatch invoker adapter.
//
// An EXAMPLE integration for ideate-core, not a core dependency. It supplies a
// `complete(req) => { ok, text }` implementation (the shape ideate-core's engine
// injects as `deps.complete`) by driving a HOST ENVIRONMENT's own subagent /
// Task-dispatch primitive — one dispatch call per generator persona.
//
// ── Why this maps onto ideate-core's method ─────────────────────────────────
// Round 1 of ideate-core's method is explicitly N INDEPENDENT, BLIND agents
// differentiated by PERSONA (persona beats temperature — Wang et al. 2023,
// Meincke et al. 2024). The engine fires every round-1 persona agent
// concurrently, calling `deps.complete(req)` once per agent with that agent's
// `persona`/`strategy`/`model` on the request. This adapter forwards each such
// call straight to the host's subagent dispatch — so "one persona agent" becomes
// "one subagent dispatch". The sharing / dedup / build-on rounds stay entirely
// inside the engine; this adapter only supplies raw round generation.
//
// ── Design properties ───────────────────────────────────────────────────────
//   - Zero-dependency ESM, matching the core's discipline. The host's dispatch
//     primitive is INJECTED (`options.dispatch`) — this file imports nothing but
//     the core's own contract, so tests stay hermetic (no real agent runtime).
//   - `ideate-core` has NO import-time dependency on this file or on any agent
//     runtime. This is one interchangeable example adapter alongside the
//     headless-CLI adapter and a user's own HTTP client.
//   - FAILS LOUDLY. A host with no subagent-dispatch capability cannot even
//     construct the adapter (`createSubagentDispatchComplete` throws when no
//     `dispatch` function is supplied), and `assertSubagentDispatchAvailable()`
//     is a preflight that throws loudly BEFORE the engine runs — never a silent
//     empty pool.
//
// ── The silent-empty-pool hazard (important) ────────────────────────────────
// ideate-core's engine wraps every per-agent `complete()` call in a try/catch
// and DROPS an agent that throws (robustness: one bad reply must not sink the
// whole run). That is correct for the engine — but it means a host that lacks a
// dispatch primitive, where EVERY agent's `complete()` throws, would otherwise
// surface as `candidates: []` with no error. To honor the adapter contract
// ("never a silently empty candidate pool"), callers must PREFLIGHT with
// `assertSubagentDispatchAvailable({ dispatch })` BEFORE `ideateCore()` — it
// runs OUTSIDE the engine's swallow and throws loudly when no dispatch
// capability is wired.

/** Error thrown by this adapter. Distinct type so callers can catch it apart
 *  from generic errors. */
export class SubagentDispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "SubagentDispatchError";
  }
}

const DEFAULT_TIMEOUT_MS = 120000;

function truncate(s, max = 500) {
  const str = String(s == null ? "" : s);
  return str.length > max ? `${str.slice(0, max)}… (${str.length} bytes)` : str;
}

/**
 * Normalize whatever a host's dispatch primitive returns into a plain reply
 * string. Tolerates the shapes a subagent runtime is likely to hand back:
 *   - a bare string (the agent's text),
 *   - `{ text }`  — the ideate-core candidate/reply shape,
 *   - `{ ok, text }` — a full complete()-style envelope (ok:false → thrown),
 *   - `{ result }` / `{ output }` — common Task-runner field names.
 * Throws `SubagentDispatchError` when no text can be extracted.
 */
export function normalizeDispatchText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (result.ok === false) {
      throw new SubagentDispatchError(
        `subagent-dispatch adapter: dispatch returned ok:false — ${truncate(result.error ?? result.text ?? "(no message)")}`,
      );
    }
    for (const key of ["text", "result", "output"]) {
      if (typeof result[key] === "string") return result[key];
    }
  }
  throw new SubagentDispatchError(
    `subagent-dispatch adapter: could not extract reply text from dispatch result — expected a string or { text | result | output }. Got: ${truncate(
      (() => {
        try {
          return JSON.stringify(result);
        } catch {
          return String(result);
        }
      })(),
    )}`,
  );
}

/**
 * Build a `complete(req) => { ok: true, text }` client that forwards each
 * round-generation call to a host's subagent/Task-dispatch primitive. Drop the
 * returned function straight into ideate-core's `deps.complete`.
 *
 * @param {object} options
 *   @param {function} options.dispatch  REQUIRED. The host's subagent dispatch,
 *     `async (task) => string | { text|result|output } | { ok, text }`. Called
 *     once per persona agent. `task` is `mapRequest(req)` (see below).
 *   @param {function} [options.mapRequest]  (req)=>task. Shapes the object handed
 *     to `dispatch` from the engine's `req` ({prompt, persona, strategy, model,
 *     temperature, ideasPerAgent}). Default forwards those fields verbatim.
 *   @param {number}   [options.timeoutMs=120000]  reject a dispatch that runs
 *     longer than this (the host may not enforce its own timeout).
 * @returns {(req:{prompt:string})=>Promise<{ok:true,text:string}>}
 */
export function createSubagentDispatchComplete(options = {}) {
  const dispatch = options.dispatch;
  if (typeof dispatch !== "function") {
    // LOUD, at construction — a host with no subagent-dispatch capability must
    // not get a silently-degrading adapter. This throw surfaces OUTSIDE the
    // engine's per-agent swallow because construction happens before the run.
    throw new SubagentDispatchError(
      "subagent-dispatch adapter: options.dispatch (function) is required — this host has no subagent-dispatch capability wired. Pass your runtime's Task/subagent dispatch, e.g. createSubagentDispatchComplete({ dispatch: (task) => runSubagent(task) }).",
    );
  }
  const mapRequest =
    typeof options.mapRequest === "function" ? options.mapRequest : defaultMapRequest;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function complete(req = {}) {
    const prompt = req && typeof req.prompt === "string" ? req.prompt : "";
    if (!prompt) {
      throw new SubagentDispatchError(
        "subagent-dispatch adapter: req.prompt (non-empty string) is required",
      );
    }

    const task = mapRequest(req);
    let result;
    try {
      result = await withTimeout(dispatch(task), timeoutMs, req.persona);
    } catch (err) {
      if (err instanceof SubagentDispatchError) throw err;
      throw new SubagentDispatchError(
        `subagent-dispatch adapter: dispatch for persona '${req.persona ?? "(none)"}' failed: ${
          err && err.message ? err.message : err
        }`,
      );
    }

    const text = normalizeDispatchText(result); // throws on ok:false / no text
    if (typeof text !== "string" || !text) {
      throw new SubagentDispatchError(
        `subagent-dispatch adapter: dispatch for persona '${req.persona ?? "(none)"}' produced empty text.`,
      );
    }
    return { ok: true, text };
  };
}

/** Default request→task mapping: forward the fields a subagent dispatch is
 *  likely to route on, verbatim. Override with `options.mapRequest`. */
function defaultMapRequest(req = {}) {
  return {
    prompt: req.prompt,
    persona: req.persona,
    strategy: req.strategy,
    model: req.model,
    temperature: req.temperature,
    ideasPerAgent: req.ideasPerAgent,
  };
}

function withTimeout(promise, timeoutMs, persona) {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new SubagentDispatchError(
          `subagent-dispatch adapter: dispatch for persona '${persona ?? "(none)"}' timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * PREFLIGHT: verify a subagent-dispatch capability is wired, loudly. Run this
 * BEFORE `ideateCore()` — the engine swallows per-agent `complete()` throws, so
 * a missing dispatch would otherwise yield a silent empty pool. Throws
 * `SubagentDispatchError` when no `dispatch` function is available.
 *
 * By default this only checks that `dispatch` is a function (a real dispatch may
 * be costly to invoke). Pass `options.probe: true` to actually run one dispatch
 * with `options.probeTask` and assert it yields extractable text.
 *
 * @param {object} options
 *   @param {function} options.dispatch  the host's subagent dispatch primitive.
 *   @param {boolean}  [options.probe=false]  actually invoke dispatch once.
 *   @param {object}   [options.probeTask]  task handed to dispatch when probing.
 * @returns {Promise<{ok:true, probed:boolean}>}
 */
export async function assertSubagentDispatchAvailable(options = {}) {
  if (typeof options.dispatch !== "function") {
    throw new SubagentDispatchError(
      "subagent-dispatch adapter: no subagent-dispatch capability available — options.dispatch (function) is required. Wire your runtime's Task/subagent dispatch before running ideation.",
    );
  }
  if (!options.probe) return { ok: true, probed: false };

  const probeTask = options.probeTask ?? {
    prompt: 'Reply with a JSON array [{"text":"ok"}].',
    persona: "__preflight__",
  };
  let result;
  try {
    result = await options.dispatch(probeTask);
  } catch (err) {
    throw new SubagentDispatchError(
      `subagent-dispatch adapter: preflight dispatch failed — the capability is wired but not working: ${
        err && err.message ? err.message : err
      }`,
    );
  }
  normalizeDispatchText(result); // throws loudly if the probe produced no text
  return { ok: true, probed: true };
}
