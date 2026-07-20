#!/usr/bin/env node
// bin/ideate.mjs — thin standalone CLI for the ideation core (cwc#737).
//
// Reads a JSON payload on stdin: { context, humanIdeas } and runs ideateCore.
// Because the core has no built-in model client or prompt copy, a live run needs
// a domain ADAPTER module supplying the deps object ideateCore takes:
//
//   echo '{"context":{"slug":"demo"},"humanIdeas":["a seed"]}' \
//     | node bin/ideate.mjs --adapter ./my-adapter.mjs
//
// The adapter must `export const deps = { complete, buildRound1Prompt, ... }`
// (or a default export of that object).
//
// Without --adapter the CLI runs in FOLD-ONLY mode: it folds the stdin
// humanIdeas via foldHumanIdeas and prints them. No API key, no network —
// useful for sanity-checking the human-idea path.
//
// Output: pretty-printed JSON { candidates: [...] } on stdout.

import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { ideateCore, foldHumanIdeas } from "../lib/ideate-core.mjs";

function parseArgs(argv) {
  const args = { adapter: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--adapter") args.adapter = argv[++i];
    else if (a.startsWith("--adapter=")) args.adapter = a.slice("--adapter=".length);
  }
  return args;
}

const HELP = `ideate — domain-agnostic ideation core (CLI)

Usage:
  echo '<json>' | node bin/ideate.mjs [--adapter <esm-module>]

Stdin JSON payload:
  { "context": <opaque domain context>, "humanIdeas": [ "idea" | {text,...} ] }

Options:
  --adapter <path>   ESM module exporting deps for ideateCore
                     (export const deps = { complete, buildRound1Prompt, ... }).
                     Required for model-driven generation.
  -h, --help         Show this help.

Without --adapter the CLI runs FOLD-ONLY: it folds humanIdeas and prints them
(no model calls, no API key).`;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadAdapter(spec) {
  const target = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  const mod = await import(pathToFileURL(target).href);
  const deps = mod.deps || mod.default;
  if (!deps || typeof deps !== "object") {
    throw new Error(`adapter ${spec} must export \`deps\` (or default) — an object for ideateCore`);
  }
  return deps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`ideate: invalid JSON on stdin — ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const context = payload.context;
  const humanIdeas = payload.humanIdeas;

  let result;
  if (args.adapter) {
    const deps = await loadAdapter(args.adapter);
    result = await ideateCore({ context, humanIdeas }, deps);
  } else {
    // Fold-only mode — no model client available.
    const candidates = foldHumanIdeas(humanIdeas, { context });
    result = { candidates, mode: "fold-only" };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`ideate: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
