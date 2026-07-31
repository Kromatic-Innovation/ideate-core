// Tests for the two shipped example prompt builders — integrations/{headless-cli,
// subagent-dispatch}/adapter.example.mjs. These `buildRound1Prompt` functions are
// the ONLY prompt strings the package ships (the core deliberately ships none),
// and neither was covered by a test. The README calls out the `{"text": "..."}`
// reply contract as the thing silently dropped if violated, so that instruction —
// and the brief interpolation — are what we pin here.
//
// Importing an adapter.example runs its load-time preflight side effects, so we
// set the documented skip flags (and point the subagent adapter at a throwaway
// dispatch module) BEFORE dynamically importing them. Fully offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_IDEAS_PER_AGENT } from "../lib/ideate-core.mjs";

// Skip the loud preflights; give the subagent adapter a no-op dispatch to load.
const dir = mkdtempSync(join(tmpdir(), "ideate-example-builders-"));
const dispatchPath = join(dir, "dispatch.mjs");
writeFileSync(dispatchPath, 'export const dispatch = async () => "[]";\n');
process.env.IDEATE_HEADLESS_SKIP_PREFLIGHT = "1";
process.env.IDEATE_SUBAGENT_SKIP_PREFLIGHT = "1";
process.env.IDEATE_SUBAGENT_DISPATCH_MODULE = dispatchPath;

// Dynamic import AFTER the env is set, so the module-load preflight is skipped.
const { buildRound1Prompt: headlessBuild } = await import("./headless-cli/adapter.example.mjs");
const { buildRound1Prompt: subagentBuild } =
  await import("./subagent-dispatch/adapter.example.mjs");

const builders = [
  ["headless-cli", headlessBuild],
  ["subagent-dispatch", subagentBuild],
];

for (const [name, build] of builders) {
  test(`${name} example builder emits the {"text"} contract and interpolates the brief (#99)`, () => {
    const prompt = build({
      context: { brief: "UNIQUE_BRIEF_MARKER_XYZ" },
      stance: "STANCE",
      persona: "pragmatist",
    });
    // The contract the README says is silently dropped if violated.
    assert.match(prompt, /\{"text"/, `${name}: must instruct the {"text"} reply shape`);
    // A change dropping the {"text"} instruction fails here.
    assert.match(prompt, /each element shaped \{"text"/, `${name}: names the per-element shape`);
    // The brief must be interpolated into the prompt.
    assert.match(prompt, /UNIQUE_BRIEF_MARKER_XYZ/, `${name}: must interpolate the brief`);
  });

  test(`${name} example builder defaults ideasPerAgent to DEFAULT_IDEAS_PER_AGENT (#99)`, () => {
    const prompt = build({ context: { brief: "b" } });
    assert.match(
      prompt,
      new RegExp(`Generate ${DEFAULT_IDEAS_PER_AGENT} `),
      `${name}: default must track DEFAULT_IDEAS_PER_AGENT, not a stale literal`,
    );
  });

  test(`${name} example builder accepts a string context as the brief (#99)`, () => {
    const prompt = build({ context: "PLAIN_STRING_BRIEF" });
    assert.match(prompt, /PLAIN_STRING_BRIEF/, `${name}: string context is the brief`);
  });
}
