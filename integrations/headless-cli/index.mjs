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
      resolve({ stdout: "", stderr: "", code: null, signal: null, spawnError: err, timedOut: false });
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
 *   @param {function} [options.spawn]  child_process.spawn shim (INJECT for tests).
 *   @param {number}   [options.timeoutMs=120000]  hard kill after this long.
 *   @param {string}   [options.cwd]  working directory for the CLI.
 *   @param {object}   [options.env]  env for the CLI (defaults to process.env).
 *   @param {function} [options.extractText]  (stdout)=>string reply extractor.
 * @returns {(req:{prompt:string})=>Promise<{ok:true,text:string}>}
 */
export function createHeadlessCliComplete(options = {}) {
  const command = options.command || DEFAULT_COMMAND;
  const args = Array.isArray(options.args) ? options.args : DEFAULT_ARGS;
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

    const { stdout, stderr, code, signal, spawnError, timedOut } = await runProcess({
      command,
      args,
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
