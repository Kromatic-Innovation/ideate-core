// integrations/sampling-params.mjs — adapter-side strip-and-warn for sampling
// parameters a target model rejects.
//
// WHY THIS LIVES IN integrations/, NOT lib/. The core (`lib/`) is deliberately
// provider-agnostic: it keeps sending `temperature` on every request and knows
// nothing about any specific model. That is the injectable-client design and it
// must not change. But current Anthropic frontier models (Opus 5, Sonnet 5,
// Opus 4.8/4.7, Fable 5) REJECT `temperature` / `top_p` / `top_k` with HTTP 400;
// Haiku 4.5 still accepts them. A default-panel run against a rejecting model
// would otherwise 400 on every agent, and because the engine swallows per-agent
// throws, the caller sees `candidates: []` with no error — the silent-empty-pool
// bug. Stripping the rejected params fixes that; WARNING when we strip is what
// keeps it from becoming a *different* silent behaviour (a caller sets
// `temperature: 0.9`, nothing errors, nothing happens, and they never learn the
// lever was inert). So: adapters strip, and warn once per (model, param).
//
// This is EXAMPLE-adapter policy — copy or override it for your own providers.
// `modelAcceptsSamplingParams` is the one place to adjust the capability map.

/** Sampling parameters the frontier models remove; stripped when unsupported. */
export const STRIPPABLE_SAMPLING_PARAMS = ["temperature", "top_p", "top_k"];

/**
 * Per-model capability check: does this model accept sampling params
 * (`temperature` / `top_p` / `top_k`)? EXAMPLE policy for Anthropic model ids:
 *   - Haiku (e.g. `claude-haiku-4-5`) still accepts them → true
 *   - Opus / Sonnet / Fable frontier tiers removed them (HTTP 400) → false
 *   - anything else (unknown / other providers) → true (never strip a param the
 *     caller set on a model we don't recognise)
 * Override this for your own provider fleet.
 *
 * @param {string} model  the model id on the request (`req.model`).
 * @returns {boolean} true if the model accepts sampling params.
 */
export function modelAcceptsSamplingParams(model) {
  if (typeof model !== "string" || !model.trim()) return true; // unknown ⇒ don't strip
  const m = model.toLowerCase();
  if (m.includes("haiku")) return true; // Haiku still accepts the sampling dials
  if (m.includes("opus") || m.includes("sonnet") || m.includes("fable")) return false;
  return true; // default: assume the model accepts them
}

/**
 * Wrap a `complete(req)` so sampling params the target model rejects are stripped
 * BEFORE the call, with a ONE-TIME warning per (model, param) — never per call
 * (a 5-agent × 2-round run would otherwise emit 10 identical warnings). Returns a
 * new `complete`; the original request object is never mutated.
 *
 * @param {(req:object)=>Promise<any>} complete  the underlying transport.
 * @param {object} [opts]
 *   @param {(model:string)=>boolean} [opts.modelAcceptsSamplingParams]  capability check.
 *   @param {(message:string)=>void}  [opts.warn]  warning sink (default process.emitWarning).
 * @returns {(req:object)=>Promise<any>}
 */
export function withSamplingParamStrip(complete, opts = {}) {
  if (typeof complete !== "function") {
    throw new TypeError("withSamplingParamStrip: complete (function) is required");
  }
  const accepts =
    typeof opts.modelAcceptsSamplingParams === "function"
      ? opts.modelAcceptsSamplingParams
      : modelAcceptsSamplingParams;
  const warn =
    typeof opts.warn === "function" ? opts.warn : (message) => process.emitWarning(message);
  const warned = new Set(); // `${model}::${param}` keys already warned about

  return async function completeWithStrip(req = {}) {
    const model = req && typeof req.model === "string" ? req.model : "";
    if (!model || accepts(model)) return complete(req);

    const toStrip = STRIPPABLE_SAMPLING_PARAMS.filter(
      (p) => req[p] !== undefined && req[p] !== null,
    );
    if (!toStrip.length) return complete(req);

    const clean = { ...req };
    for (const p of toStrip) {
      delete clean[p];
      const key = `${model}::${p}`;
      if (!warned.has(key)) {
        warned.add(key);
        warn(
          `ideate-core: model "${model}" rejects the sampling parameter "${p}"; ` +
            `stripping it before the call. On this model, persona (not ${p}) is the ` +
            `diversity lever. (Warned once per model+param.)`,
        );
      }
    }
    return complete(clean);
  };
}
