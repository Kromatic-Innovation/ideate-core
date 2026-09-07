// integrations/headless-cli/index.mjs — headless-CLI invoker adapter.
//
// An EXAMPLE integration for ideate-core, not a core dependency. It supplies a
// `complete(req) => { ok, text }` implementation (the shape ideate-core's engine
// injects as `deps.complete`) by shelling out to a locally-installed, locally-
// AUTHENTICATED headless Claude Code CLI session — `claude -p --output-format
// json` by default — instead of a metered API key. Any Claude Code user can run
// ideation on their existing session auth with no second credential.
//
// ── Design properties ───────────────────────────────────────────────────────
//   - Zero-dependency ESM, matching the core's discipline. The only runtime
//     requirement is Node's built-in child_process — and even that is INJECTABLE
//     (`options.spawn`) so tests stay hermetic (no real process, no network).
//   - `ideate-core` has NO import-time dependency on this file or on the `claude`
//     CLI. This is one interchangeable example adapter living alongside the core;
//     the subagent-dispatch adapter and a user's own HTTP client are equally
//     first-class.
//   - FAILS LOUDLY. A missing or unauthenticated CLI, a non-zero exit, or an
//     unparseable reply throws a descriptive Error — never a silent empty pool.
//
// ── Routing parity (ideate-core#151) ────────────────────────────────────────
// This adapter aims for routing PARITY with a metered-API adapter, not a
// reduced feature set — the point of running on the CLI is the *credential*
// (no second auth to manage), not fewer routing knobs. Of the engine's
// per-agent request fields:
//   - `model`   → forwarded as `--model <value>` (accepts the CLI's aliases —
//                 `opus`/`sonnet`/`fable` — or a full model name).
//   - `effort`  → forwarded as `--effort <value>`. The CLI's ladder (`low,
//                 medium, high, xhigh, max`) is IDENTICAL to the API's
//                 `output_config.effort`, so it passes through verbatim with
//                 no provider-specific mapping.
//   - `temperature`, `maxTokens` → NOT forwarded. The CLI has no flag for
//                 either. `--max-budget-usd` exists but is a dollar SPEND cap,
//                 not a token cap — do not map `maxTokens` onto it; that would
//                 silently change its meaning.
//   - `persona`, `strategy`, `ideasPerAgent` → not request-shaped for this
//                 adapter at all; the engine's prompt builders already encode
//                 them into the prompt text, so there is nothing to forward.
// Both fields are OPTIONAL and independent: absent on the request means
// absent on the CLI invocation — this adapter never synthesizes a default or
// emits a bare flag with no value.
//
// Caller-supplied `options.args` vs. these per-agent fields: when a caller's
// own `args` already contains `--model`/`--effort` (either as two elements,
// `--model value`, or one, `--model=value`) AND the request carries that same
// field, the PER-AGENT REQUEST FIELD WINS — the caller's entry is stripped out
// of the base args and re-appended with the request's value in the
// `--flag value` form. Rationale: distinguishing routing per agent is the
// entire point of a panel; a caller who wants a single fixed model for every
// agent should leave it off the per-agent request instead of baking it into
// `args`. If the request field is absent, the caller's `args` are left
// completely untouched. A forwarded value must be a plain string that does
// not itself look like a flag (does not start with `-`) — anything else is a
// loud throw, never forwarded, so a routing value can never swallow or
// duplicate an adjacent flag.
//
// `options.args`'s "replace DEFAULT_ARGS" semantics has ONE guaranteed
// exception (ideate-core#152 review, finding 1): `-p` and `--output-format`
// are always present in the final argv, added — never overriding a value
// already there — only when a caller's `args` omits them entirely. Without
// this, a caller `args` missing `--output-format json` produced non-JSON
// prose on stdout that `defaultExtractText` tolerates as a fallback and
// returns as `{ok:true, text:"<prose>"}` with no throw anywhere — exactly the
// silent-empty/junk-pool hazard this adapter exists to prevent, on a path no
// existing test exercised (every prior caller-`args` test happened to include
// both flags already). A caller supplying its own `extractText` and wanting
// `--output-format text` keeps that choice: this only adds a flag that is
// completely missing, never touches one the caller already set.
//
// ── The silent-empty-pool hazard (important) ────────────────────────────────
// ideate-core's engine wraps every per-agent `complete()` call in a try/catch
// and DROPS an agent that throws (robustness: one bad model reply must not sink
// the whole run). That is correct for the engine — but it means a *totally*
// missing/unauthenticated CLI, where EVERY agent's `complete()` throws, would
// otherwise surface as `candidates: []` with no error. To honor the adapter
// contract ("never a silently empty candidate pool"), callers must PREFLIGHT
// with `assertHeadlessCliAvailable()` BEFORE `ideateCore()` — this runs a cheap
// `claude --version` probe OUTSIDE the engine's swallow and throws loudly if the
// CLI is absent or unauthenticated. `adapter.example.mjs` runs that preflight at
// import time, so `ideate --adapter …/adapter.example.mjs` exits non-zero and
// loud when the CLI is missing.

import { spawn as realSpawn } from "node:child_process";

/** Error thrown by this adapter. Distinct type so callers can catch it apart
 *  from generic errors, and so `defaultExtractText` can rethrow past the JSON
 *  try/catch. */
export class HeadlessCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeadlessCliError";
  }
}

const DEFAULT_COMMAND = "claude";
const DEFAULT_ARGS = ["-p", "--output-format", "json"];
const DEFAULT_PROBE_ARGS = ["--version"];
const DEFAULT_TIMEOUT_MS = 120000;

/** Remove `flag` (and the value that follows it) OR a single `flag=value`
 *  element from an args array, if present. Used to let a per-agent request
 *  field override a caller-supplied `args` entry for the same flag without
 *  leaving a stale, conflicting entry behind — whichever of the two
 *  equally-standard CLI forms (`--model value` or `--model=value`) the
 *  caller used.
 *
 *  NOTE (ideate-core#153, noticed; closed by ideate-core#158): this walk is
 *  positional-blind the same way `hasFlag` was — `stripFlagPair(["--effort",
 *  "--model"], "--model")` treats the literal string "--model" (actually
 *  `--effort`'s value) as a flag occurrence and strips it. This is worse
 *  than a dropped value: `--model`'s own consumed-value logic then eats the
 *  NEXT token as if it belonged to the (removed) "--model" occurrence, so
 *  with `req.model="opus"` set, `["--effort","--model"]` would become
 *  `["--effort","--model","opus","-p","--output-format","json"]` — `opus`
 *  surviving as a stray trailing positional argument, which on a `-p` run
 *  can be read as (or concatenated into) the prompt, ahead of the real one
 *  fed on stdin. `assertForwardableRoutingValue` blocks a flag-shaped value
 *  from the per-agent *request* (`req.model`/`req.effort`), but has no
 *  visibility into caller-supplied `args` — which is exactly why this gap
 *  existed here and not there. `assertSafeBaseArgs` now refuses this shape
 *  at construction (see its case (c)) rather than leaving `stripFlagPair`
 *  to silently mishandle it — see the file's PR discussion for why this and
 *  `hasFlag`/`hasPrintFlag` were not unified into one helper. */
function stripFlagPair(args, flag) {
  const eqPrefix = `${flag}=`;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++; // also skip the value that follows the flag
      continue;
    }
    if (typeof args[i] === "string" && args[i].startsWith(eqPrefix)) {
      continue; // `--flag=value` is a single element — no separate value token
    }
    out.push(args[i]);
  }
  return out;
}

/** True if `flag` appears in `args` either as a bare token or as the single-
 *  token `flag=value` form. Positional-blind by design here: it is only
 *  ever called for `--output-format` (see `ensureRequiredFlags`), where the
 *  file header's "never overriding a value you did set" promise (an
 *  explicit `--output-format text` caller choice, ideate-core#152 finding 1)
 *  means a false positive (treating a stray value token as the flag) is the
 *  SAFE direction to err in — it just leaves the caller's args untouched.
 *  Do not reuse this for `-p`/`--print`; see `hasPrintFlag` below, which
 *  needs the opposite bias. */
function hasFlag(args, flag) {
  return args.some((a) => a === flag || (typeof a === "string" && a.startsWith(`${flag}=`)));
}

/** The two spellings of the CLI's print flag (`claude --help`: "-p, --print
 *  Print response and exit"). Boolean flag — no `=value` form exists for it,
 *  so unlike `hasFlag` there is no `flag=value` case to check. */
const PRINT_FLAG_NAMES = ["-p", "--print"];

/**
 * True if `-p`/`--print` is genuinely present as a flag occurrence in
 * `args` — not merely sitting in the *value* position of some other flag
 * (ideate-core#153, finding a). Empirically, `args: ["--append-system-prompt",
 * "-p"]` is real caller input: `--append-system-prompt` takes a value, and a
 * caller's literal `-p` string there is that value, not a print flag.
 * `hasFlag`'s old blanket `.some()` counted it as one anyway, which made
 * `ensureRequiredFlags` skip injecting a REAL print flag — the CLI then ran
 * interactively, emitted prose, and `defaultExtractText`'s fallback silently
 * returned `{ok:true, text:"<prose>"}` (same terminus as the ideate-core#152
 * defect).
 *
 * A token counts as a print-flag occurrence only when it matches one of
 * `PRINT_FLAG_NAMES` AND it is at index 0, or the token immediately before
 * it does not itself look like a flag (start with `-`). This is
 * deliberately biased toward UNDER-counting: the cost of a false negative
 * here is a harmless duplicate `-p`/`--print` in the final argv. Verified
 * empirically WITHOUT spawning a real completion: `claude --print --print
 * --definitely-not-a-flag` and `claude -p -p --definitely-not-a-flag` both
 * fail with `error: unknown option '--definitely-not-a-flag'` — i.e. the
 * parser accepted both repeated print tokens and only then choked on the
 * bogus one, rather than erroring on the duplicate itself. (An earlier
 * version of this note cited `claude --print --print --version`, exit 0 —
 * a weaker probe, since `--version` can short-circuit during parsing before
 * any duplicate-option validation would run; the `--definitely-not-a-flag`
 * probe forces parsing to continue past both `--print` tokens first, so it
 * actually demonstrates what this comment claims.) No prompt-bearing
 * invocation was run either way, zero model spend. The cost of a false
 * positive, in contrast, is the silent prose-fallback above.
 * That asymmetry is also why this is a separate function from `hasFlag`
 * rather than one "value-aware" helper with a policy switch: the two flags
 * need opposite biases, and `stripFlagPair` needs a third, exact-positional
 * behavior again (see its NOTE) — three policies in one helper was judged
 * not worth the indirection for two call sites.
 */
function hasPrintFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string" || !PRINT_FLAG_NAMES.includes(token)) continue;
    const prev = i > 0 ? args[i - 1] : undefined;
    const looksLikeValueOfPrecedingFlag = typeof prev === "string" && prev.startsWith("-");
    if (!looksLikeValueOfPrecedingFlag) return true;
  }
  return false;
}

/** The two routing flags THIS adapter itself forwards/manipulates (see
 *  `stripFlagPair` above and the per-agent forwarding in `complete()`). This
 *  is the only flag-arity knowledge this file has — not a general table of
 *  the `claude` CLI's flag surface (ideate-core#158 decision: refuse
 *  unsafe caller `args` shapes rather than build one). */
const FORWARDED_ROUTING_FLAGS = ["--model", "--effort"];

/** Flags safe to be the LAST token in a caller's `args` even though
 *  something else still needs to be appended after them: `PRINT_FLAG_NAMES`
 *  take no value at all, and `FORWARDED_ROUTING_FLAGS` self-heal via the
 *  strip/append forwarding in `complete()` whenever the matching
 *  `req.model`/`req.effort` field is supplied (ideate-core#158 PR body notes
 *  the residual gap for a call that never supplies it). Any OTHER trailing
 *  flag-shaped token is unsafe to append after, because this file has no
 *  idea whether it takes a value. */
const TRAILING_FLAG_SAFE_LIST = new Set([...PRINT_FLAG_NAMES, ...FORWARDED_ROUTING_FLAGS]);

/** True if `token` is shaped like a flag occurrence — starts with `-` and is
 *  NOT the single-token `flag=value` form (which is self-contained and
 *  cannot consume anything appended after it). */
function looksLikeFlag(token) {
  return typeof token === "string" && token.startsWith("-") && !token.includes("=");
}

/**
 * Refuse, at `createHeadlessCliComplete` CONSTRUCTION (over the caller's
 * static `options.args`, never per-call), the caller-`args` shapes this
 * adapter cannot safely extend (ideate-core#158). Throwing here — rather
 * than per-call — means a bad `options.args` fails immediately and loudly,
 * instead of surfacing as a dropped agent inside the engine's per-call
 * `complete()` swallow on whichever call happens to hit it.
 *
 * Deliberately NOT a flag-arity table for the `claude` CLI: every check
 * below is a shape test on the caller's own `args` array. The one place
 * this file has any flag-specific knowledge is `FORWARDED_ROUTING_FLAGS`
 * (`--model`/`--effort`) — flags this adapter already forwards itself, so
 * knowing they take a value is not new knowledge being introduced here.
 */
function assertSafeBaseArgs(args) {
  // (a) ideate-core#158: `--` is the CLI's end-of-options marker — every
  // token after it is a positional by definition, so an injected -p/
  // --output-format placed after it (or before it, immaterial: the marker
  // makes the injected flags for THIS array meaningless once it appears at
  // all) has no effect. Whatever the caller intended, this adapter cannot
  // safely extend an args array containing "--".
  if (args.includes("--")) {
    throw new HeadlessCliError(
      'headless-cli adapter: options.args contains "--" (the CLI\'s end-of-options ' +
        "marker) — every token after it is treated as a positional, so this adapter's " +
        "injected -p/--output-format flags would have no effect (ideate-core#158). " +
        'Remove "--" from options.args, or build the full argv yourself and pass ' +
        "options.extractText/options.command without relying on this adapter's flag injection.",
    );
  }

  // (b) ideate-core#158: a trailing flag-shaped token this file does not
  // know the arity of. `ensureRequiredFlags` always appends at the END of
  // the array, so if the last token is a flag that itself takes a value,
  // the appended -p/--output-format (or its "json" value) would be
  // silently consumed as that flag's argument instead.
  const last = args[args.length - 1];
  if (looksLikeFlag(last) && !TRAILING_FLAG_SAFE_LIST.has(last)) {
    throw new HeadlessCliError(
      `headless-cli adapter: options.args ends with ${JSON.stringify(last)}, a flag ` +
        "this adapter does not know the arity of — appending -p/--output-format " +
        `after it risks being silently consumed as ${JSON.stringify(last)}'s value ` +
        `(ideate-core#158). Give ${JSON.stringify(last)} an explicit value in ` +
        "options.args, or move it earlier in the array so it is not last.",
    );
  }

  // (c) ideate-core#158: one of THIS adapter's own forwarded routing flags
  // followed by a flag-shaped token. `stripFlagPair` matches a flag
  // occurrence by exact string equality, positional-blind — it cannot tell
  // that token apart from a real occurrence of that flag, so removing it
  // (when the matching req field is later forwarded) desynchronizes the
  // array and leaves the flag-shaped token as a stray positional.
  for (let i = 0; i < args.length; i++) {
    if (FORWARDED_ROUTING_FLAGS.includes(args[i]) && looksLikeFlag(args[i + 1])) {
      throw new HeadlessCliError(
        `headless-cli adapter: options.args has ${args[i]} immediately followed by ` +
          `${JSON.stringify(args[i + 1])}, a flag-shaped token that would be treated ` +
          `as ${args[i]}'s value (ideate-core#158). Give ${args[i]} a real value in ` +
          `options.args, or drop it from options.args and forward it per-agent via ` +
          `req.${args[i].slice(2)} instead.`,
      );
    }
  }
}

/**
 * Guarantee `-p` and `--output-format` are present in the final argv, WITHOUT
 * overriding a value the caller already supplied — see the file header
 * ("ideate-core#152 review, finding 1") for why this exists. Only ever ADDS a
 * flag that is entirely missing from `args`; never touches one already there.
 */
function ensureRequiredFlags(args) {
  let out = args;
  if (!hasPrintFlag(out)) out = [...out, "-p"];
  if (!hasFlag(out, "--output-format")) out = [...out, "--output-format", "json"];
  return out;
}

/**
 * Validate a routing field's value before it is forwarded as a CLI flag
 * argument. Throws HeadlessCliError (never silently coerces or drops) when
 * the value is not a plain string, or when it looks like a flag itself
 * (starts with `-`) — the latter would otherwise let the value swallow or
 * duplicate an adjacent flag in the argv (ideate-core#152 review, finding 4).
 */
function assertForwardableRoutingValue(fieldName, flag, value) {
  if (typeof value !== "string") {
    throw new HeadlessCliError(
      `headless-cli adapter: req.${fieldName} must be a string to forward as ${flag} — got ${typeof value}. Refusing to forward a non-string value to the CLI.`,
    );
  }
  if (value.startsWith("-")) {
    throw new HeadlessCliError(
      `headless-cli adapter: req.${fieldName} value ${JSON.stringify(value)} looks like a flag, not a value — refusing to forward it as ${flag}'s argument.`,
    );
  }
}

function truncate(s, max = 500) {
  const str = String(s == null ? "" : s);
  return str.length > max ? `${str.slice(0, max)}… (${str.length} bytes)` : str;
}

/**
 * Run a child process to completion, writing `input` to its stdin and buffering
 * stdout/stderr. Never rejects — resolves with a result envelope so the caller
 * decides what is fatal. Fully injectable via `spawn` for hermetic tests.
 *
 * @returns {Promise<{stdout:string, stderr:string, code:number|null,
 *   signal:string|null, spawnError:Error|null, timedOut:boolean}>}
 */
export function runProcess({
  command,
  args = [],
  input = "",
  spawn = realSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
  env,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        spawnError: err,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;

    const done = (envelope) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(envelope);
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += d));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (stderr += d));
    }

    child.on("error", (err) => {
      done({ stdout, stderr, code: null, signal: null, spawnError: err, timedOut });
    });
    child.on("close", (code, signal) => {
      done({ stdout, stderr, code, signal, spawnError: null, timedOut });
    });

    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }

    // Feed the prompt on stdin and close it so the CLI runs to completion.
    if (child.stdin) {
      child.stdin.on("error", () => {
        /* EPIPE if the child never reads stdin — non-fatal; close/error handles it */
      });
      try {
        child.stdin.end(input);
      } catch {
        /* ignore — close/error path reports the real failure */
      }
    }
  });
}

/**
 * Default extractor for `claude -p --output-format json`, whose stdout is a JSON
 * envelope like `{ "type":"result", "is_error":false, "result":"…" }`. Returns
 * the assistant text. Tolerates `--output-format text` (raw, non-JSON stdout) by
 * returning the trimmed body. Throws (loudly) when the CLI signalled an error.
 */
export function defaultExtractText(stdout) {
  const trimmed = String(stdout == null ? "" : stdout).trim();
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — assume plain-text output format; the raw body is the reply.
    return trimmed;
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.is_error === true) {
      throw new HeadlessCliError(
        `headless-cli adapter: CLI reported is_error=true — ${truncate(parsed.result ?? parsed.error ?? "(no message)")}`,
      );
    }
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.text === "string") return parsed.text;
    return "";
  }
  if (typeof parsed === "string") return parsed;
  return "";
}

/**
 * Build a `complete(req) => { ok: true, text }` client that shells out to a
 * headless CLI. Drop this straight into ideate-core's `deps.complete`.
 *
 * @param {object} [options]
 *   @param {string}   [options.command="claude"]  the executable to run.
 *   @param {string[]} [options.args]  args passed to it (default: headless JSON print).
 *     Overrides the default array, but `-p` and `--output-format` are always
 *     guaranteed present — added only if your array omits them entirely,
 *     never overriding a value you did set (see file header, finding 1).
 *   @param {function} [options.spawn]  child_process.spawn shim (INJECT for tests).
 *   @param {number}   [options.timeoutMs=120000]  hard kill after this long.
 *   @param {string}   [options.cwd]  working directory for the CLI.
 *   @param {object}   [options.env]  env for the CLI (defaults to process.env).
 *   @param {function} [options.extractText]  (stdout)=>string reply extractor.
 * @returns {(req:{prompt:string, model?:string, effort?:string})=>Promise<{ok:true,text:string}>}
 *   `req.model` forwards as `--model <value>`; `req.effort` forwards as
 *   `--effort <value>`; both override a same-named flag in `options.args`.
 *   `req.temperature`/`req.maxTokens` are accepted (per the engine's request
 *   shape) but not forwarded — see the file header for why.
 */
export function createHeadlessCliComplete(options = {}) {
  const command = options.command || DEFAULT_COMMAND;
  const baseArgs = Array.isArray(options.args) ? options.args : DEFAULT_ARGS;
  assertSafeBaseArgs(baseArgs);
  const spawn = typeof options.spawn === "function" ? options.spawn : realSpawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd;
  const env = options.env;
  const extractText =
    typeof options.extractText === "function" ? options.extractText : defaultExtractText;

  return async function complete(req = {}) {
    const prompt = req && typeof req.prompt === "string" ? req.prompt : "";
    if (!prompt) {
      throw new HeadlessCliError("headless-cli adapter: req.prompt (non-empty string) is required");
    }

    // Per-agent routing parity (ideate-core#151): forward `model`/`effort`
    // when present, overriding a same-named flag already in `baseArgs`.
    // Absent stays absent — never synthesize a default or a bare flag.
    let callArgs = baseArgs;
    if (req.model) {
      assertForwardableRoutingValue("model", "--model", req.model);
      callArgs = stripFlagPair(callArgs, "--model");
      callArgs = [...callArgs, "--model", req.model];
    }
    if (req.effort) {
      assertForwardableRoutingValue("effort", "--effort", req.effort);
      callArgs = stripFlagPair(callArgs, "--effort");
      callArgs = [...callArgs, "--effort", req.effort];
    }

    // ideate-core#152 review round 2, finding 1: this MUST run after the
    // strip/append above, not once at construction on `baseArgs`. Applying it
    // to `baseArgs` up front means a caller `args` ending in a bare, value-
    // taking flag (e.g. `["--model"]`) gets `-p`/`--output-format json`
    // appended directly after that bare flag — positioning the injected `-p`
    // exactly where `stripFlagPair` above expects to find (and consume) the
    // flag's value, deleting it. Applying it here, to the post-strip
    // `callArgs`, guarantees the two required flags in the FINAL argv
    // regardless of what shape the caller's `args` or the per-agent
    // model/effort forwarding left behind.
    callArgs = ensureRequiredFlags(callArgs);

    const { stdout, stderr, code, signal, spawnError, timedOut } = await runProcess({
      command,
      args: callArgs,
      input: prompt,
      spawn,
      timeoutMs,
      cwd,
      env,
    });

    if (spawnError) {
      if (spawnError.code === "ENOENT") {
        throw new HeadlessCliError(
          `headless-cli adapter: '${command}' not found on PATH. Install the Claude Code CLI and sign in (\`claude\`), or pass a different \`command\`. Original: ${spawnError.message}`,
        );
      }
      throw new HeadlessCliError(
        `headless-cli adapter: failed to spawn '${command}': ${spawnError.message}`,
      );
    }
    if (timedOut) {
      throw new HeadlessCliError(
        `headless-cli adapter: '${command}' timed out after ${timeoutMs}ms and was killed.`,
      );
    }
    if (code !== 0) {
      throw new HeadlessCliError(
        `headless-cli adapter: '${command}' exited ${code === null ? `via signal ${signal}` : `with code ${code}`}. stderr: ${truncate(stderr)}`,
      );
    }

    const text = extractText(stdout); // may throw HeadlessCliError on is_error
    if (typeof text !== "string" || !text) {
      throw new HeadlessCliError(
        `headless-cli adapter: could not extract non-empty text from CLI output. Raw stdout: ${truncate(stdout)}`,
      );
    }
    return { ok: true, text };
  };
}

/**
 * PREFLIGHT: verify the headless CLI is installed AND authenticated, loudly.
 * Run this BEFORE `ideateCore()` — the engine swallows per-agent `complete()`
 * throws, so a missing CLI would otherwise yield a silent empty pool. Throws
 * `HeadlessCliError` when the CLI is absent, errors, or the probe fails.
 *
 * @param {object} [options] same shape as createHeadlessCliComplete, plus:
 *   @param {string[]} [options.probeArgs=["--version"]]  cheap liveness probe.
 * @returns {Promise<{ok:true, version:string}>}
 */
export async function assertHeadlessCliAvailable(options = {}) {
  const command = options.command || DEFAULT_COMMAND;
  const probeArgs = Array.isArray(options.probeArgs) ? options.probeArgs : DEFAULT_PROBE_ARGS;
  const spawn = typeof options.spawn === "function" ? options.spawn : realSpawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const { stdout, stderr, code, signal, spawnError, timedOut } = await runProcess({
    command,
    args: probeArgs,
    input: "",
    spawn,
    timeoutMs,
    cwd: options.cwd,
    env: options.env,
  });

  if (spawnError) {
    if (spawnError.code === "ENOENT") {
      throw new HeadlessCliError(
        `headless-cli adapter: '${command}' not found on PATH — install the Claude Code CLI and sign in (\`claude\`) before running ideation. Original: ${spawnError.message}`,
      );
    }
    throw new HeadlessCliError(
      `headless-cli adapter: could not probe '${command}': ${spawnError.message}`,
    );
  }
  if (timedOut) {
    throw new HeadlessCliError(
      `headless-cli adapter: probe of '${command}' timed out after ${timeoutMs}ms.`,
    );
  }
  if (code !== 0) {
    throw new HeadlessCliError(
      `headless-cli adapter: '${command} ${probeArgs.join(" ")}' exited ${
        code === null ? `via signal ${signal}` : `with code ${code}`
      } — the CLI may be installed but not authenticated. stderr: ${truncate(stderr)}`,
    );
  }
  return { ok: true, version: String(stdout).trim() };
}
