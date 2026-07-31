// integrations/headless-cli/adapter.example.mjs — a ready-to-run `deps` adapter
// wiring the headless-CLI invoker into `bin/ideate.mjs --adapter`.
//
//   echo '{"context":{"slug":"launch","brief":"ways to promote a product launch"}}' \
//     | node bin/ideate.mjs --adapter ./integrations/headless-cli/adapter.example.mjs
//
// This module exports `deps = { complete, buildRound1Prompt }` — the two things
// a live ideate-core run needs. `complete` shells out to a locally-authenticated
// `claude -p --output-format json` (no metered API key); `buildRound1Prompt` is a
// generic, domain-agnostic prompt builder you are meant to replace for your own
// domain.
//
// LOUD-FAILURE PREFLIGHT: on import this module runs `assertHeadlessCliAvailable()`
// so `ideate --adapter …` exits non-zero with a clear message when the CLI is
// missing or unauthenticated — never a silently empty candidate pool. Set
// IDEATE_HEADLESS_SKIP_PREFLIGHT=1 to skip the probe (e.g. when composing this
// adapter into your own harness that preflights itself).

import { createHeadlessCliComplete, assertHeadlessCliAvailable } from "./index.mjs";
import { withSamplingParamStrip } from "../sampling-params.mjs";
import { DEFAULT_IDEAS_PER_AGENT } from "../../lib/ideate-core.mjs";

// A generic round-1 prompt builder. `context` may be a string or an object with
// a `brief` (falls back to JSON-stringifying the context). Replace this with a
// domain-specific builder for real use. Defaults ideasPerAgent to the core's
// DEFAULT_IDEAS_PER_AGENT rather than a hardcoded literal so it can't drift.
export function buildRound1Prompt({
  context,
  stance,
  ideasPerAgent = DEFAULT_IDEAS_PER_AGENT,
} = {}) {
  const brief =
    typeof context === "string"
      ? context
      : context && typeof context.brief === "string"
        ? context.brief
        : JSON.stringify(context ?? {});
  return (
    `${stance ? stance + "\n\n" : ""}` +
    `Generate ${ideasPerAgent} genuinely different ideas for the following brief.\n\n` +
    `BRIEF: ${brief}\n\n` +
    `Reply with ONLY a JSON array, each element shaped {"text": "the idea"} — ` +
    `no prose, no markdown fences, no title/body fields.`
  );
}

// Loud preflight so a missing/unauthenticated CLI is a hard, non-zero failure at
// adapter-load time rather than a silent empty pool once the engine runs.
if (!process.env.IDEATE_HEADLESS_SKIP_PREFLIGHT) {
  await assertHeadlessCliAvailable();
}

// Strip-and-warn: on a model that rejects temperature/top_p/top_k (current
// Anthropic frontier tiers), remove the param before the call and warn once per
// (model, param) — so a rejecting model produces candidates instead of a silent
// empty pool, and a caller learns their sampling knob is inert on that model
// rather than mysteriously ignored.
export const complete = withSamplingParamStrip(createHeadlessCliComplete());

export const deps = { complete, buildRound1Prompt };
export default deps;
