// integrations/subagent-dispatch/adapter.example.mjs — a ready-to-run `deps`
// adapter wiring the subagent-dispatch invoker into `bin/ideate.mjs --adapter`.
//
// Unlike the headless-CLI adapter, there is no single universal subagent
// primitive to shell out to — the dispatch function is HOST-SPECIFIC. So this
// example loads YOUR dispatch from an ESM module you point it at:
//
//   IDEATE_SUBAGENT_DISPATCH_MODULE=./my-dispatch.mjs \
//   echo '{"context":{"brief":"ways to promote a product launch"}}' \
//     | node bin/ideate.mjs --adapter ./integrations/subagent-dispatch/adapter.example.mjs
//
// `./my-dispatch.mjs` must `export const dispatch = async (task) => "…text…"`
// (or `{ text }` / `{ result }` / `{ output }`), where `task` is one persona's
// { prompt, persona, strategy, model, temperature, ideasPerAgent }. That is the
// one function that hands a persona prompt to your runtime's Task/subagent
// primitive and returns its reply.
//
// This module exports `deps = { complete, buildRound1Prompt }`. On import it
// runs `assertSubagentDispatchAvailable()` so a missing/unwired dispatch is a
// hard, non-zero failure at adapter-load time — never a silently empty pool.
// Set IDEATE_SUBAGENT_SKIP_PREFLIGHT=1 to skip the check (e.g. when composing
// this adapter into your own harness that preflights itself).

import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

import {
  createSubagentDispatchComplete,
  assertSubagentDispatchAvailable,
} from "./index.mjs";

// A generic, PERSONA-AWARE round-1 prompt builder. Round 1 differentiates agents
// by persona (persona beats temperature), so the persona/stance is woven into
// the prompt. `context` may be a string or an object with a `brief`. Replace
// this with a domain-specific builder for real use.
export function buildRound1Prompt({ context, persona, stance, ideasPerAgent = 6 } = {}) {
  const brief =
    typeof context === "string"
      ? context
      : context && typeof context.brief === "string"
        ? context.brief
        : JSON.stringify(context ?? {});
  const voice = persona ? `You are ${persona}. ` : "";
  return (
    `${voice}${stance ? stance + "\n\n" : ""}` +
    `Generate ${ideasPerAgent} genuinely different ideas for the following brief, ` +
    `in your own distinct point of view.\n\n` +
    `BRIEF: ${brief}\n\n` +
    `Reply with ONLY a JSON array, each element shaped {"text": "the idea"} — ` +
    `no prose, no markdown fences, no title/body fields.`
  );
}

async function loadHostDispatch() {
  const spec = process.env.IDEATE_SUBAGENT_DISPATCH_MODULE;
  if (!spec) {
    throw new Error(
      "subagent-dispatch adapter.example: set IDEATE_SUBAGENT_DISPATCH_MODULE to an ESM module exporting `dispatch` (your host's Task/subagent primitive). See integrations/subagent-dispatch/README.md.",
    );
  }
  const target = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  const mod = await import(pathToFileURL(target).href);
  const dispatch = mod.dispatch || mod.default;
  if (typeof dispatch !== "function") {
    throw new Error(
      `subagent-dispatch adapter.example: ${spec} must export \`dispatch\` (or default) — an async (task)=>reply function.`,
    );
  }
  return dispatch;
}

const dispatch = await loadHostDispatch();

// Loud preflight so a missing/unwired dispatch is a hard, non-zero failure at
// adapter-load time rather than a silent empty pool once the engine runs.
if (!process.env.IDEATE_SUBAGENT_SKIP_PREFLIGHT) {
  await assertSubagentDispatchAvailable({ dispatch });
}

export const complete = createSubagentDispatchComplete({ dispatch });

export const deps = { complete, buildRound1Prompt };
export default deps;
