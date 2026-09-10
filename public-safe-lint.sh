#!/usr/bin/env bash
# public-safe-lint.sh — a portable, org-agnostic file-shape scanner.
#
# The scanner invoked by the companion public-safe-lint.template.yml
# workflow. This script carries ZERO organization-specific strings -- only
# generic SHAPES that any open-source repository would want to catch in its
# own CI, including on pull requests from outside contributors where no
# repository secret is ever injected:
#   - local absolute filesystem paths (a personal username or home directory
#     leaking into a public file)
#   - home-directory-relative paths
#   - bare numeric issue references with no repository qualifier
#   - plus-addressed email aliases (personal test-account leakage)
#   - personal-attribution phrases
#
# This script must never be pointed at, or combined with, any private
# pattern inventory -- doing so would defeat the point of keeping it
# adoptable on fork pull requests, which receive no injected secrets or
# private config of any kind.
#
# Output discipline: this script reports file:line and a rule name only --
# it never prints the matched substring itself. A linter that prints the
# matched text into a public CI log republishes exactly what a leak-detector
# exists to prevent, so this discipline holds even though every pattern
# here is a generic shape rather than a specific secret.
#
# Every run also asserts, before trusting any clean result, that a known-bad
# seed value actually matches its rule -- once per ACTIVE rule, not merely
# once overall (see the canary block below). This guards against a scanner
# that silently matches nothing while still reporting success, and against a
# configuration that quietly scopes the scan down to nothing.
#
# ---------------------------------------------------------------------------
# CONFIGURATION (optional -- a repo that supplies none behaves as if this
# section did not exist)
#
# Adopting repos must not have to edit this file or the companion workflow:
# editing either forfeits byte-identity with the upstream template. So all
# scoping lives in a sidecar config file, read from the ROOT OF THE SCANNED
# TREE, named:
#
#     .public-safe-lint.conf
#
# Format: `key = value` lines. Blank lines are ignored; a line whose first
# non-blank character is `#` is a comment (inline comments are NOT stripped,
# so do not append one to a value). Keys repeat, and values may also be
# comma-separated. Recognised keys:
#
#     disable      -- rule name(s) to switch off entirely
#     exclude-dir  -- extra directory name(s) to skip (as grep --exclude-dir)
#     exclude      -- extra file glob(s) to skip (as grep --exclude)
#
# Example:
#
#     # this repo is public and its issue tracker is public, so a bare
#     # numeric ref resolves for exactly the reader the file is written for
#     disable = bare-issue-ref
#     exclude-dir = vendor
#     exclude = *.min.js
#
# The file is PARSED, never sourced or evaluated: on a fork pull request the
# config is attacker-controlled content like any other file in the tree, so
# it can never execute anything, values are charset-restricted, and every
# value reaches grep as a single quoted argument.
#
# An unknown key, an unknown rule name, or a value outside the permitted
# charset is a hard error -- a config the scanner does not understand fails
# the run rather than being silently half-applied.
#
# Two floors make a scoped config safe to trust:
#   1. At least one rule must remain active; disabling all of them is an
#      error, not a clean scan.
#   2. Every rule that remains active must still match its own known-bad
#      seed, and the canary line names how many rules that was. A scoped
#      config therefore cannot be mistaken for, or degrade into, a scan that
#      matched nothing.
# Both the config path and the disabled rule names are echoed into the run
# log, so a reviewer reading a fork PR's CI output can see what that PR's
# config switched off.
#
# PUBLIC_SAFE_LINT_CONFIG=<path> overrides the config location (used to scan
# a tree read-only, without writing a config file into it). When it is set,
# the file must exist.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat <<EOF
usage: $SCRIPT_NAME <path-to-scan>

Scans <path-to-scan> for org-agnostic public-safety shapes (local absolute
paths, bare issue refs, +alias emails, personal-attribution phrases). Prints
file:line and rule name only -- never the matched text. Exits non-zero on
any hit, on a canary failure, on a config error, or on a usage error.

Optional per-repo scoping lives in <path-to-scan>/.public-safe-lint.conf
(override with PUBLIC_SAFE_LINT_CONFIG=<path>). Keys: disable, exclude-dir,
exclude. See the comment header of this script for the full format.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

ROOT="${1:?$(usage)}"

if [ ! -d "$ROOT" ]; then
  echo "FAIL: scan path does not exist or is not a directory: $ROOT" >&2
  exit 1
fi

# Rule table: name<TAB>grep-E-pattern<TAB>word-boundary(0/1)<TAB>case(i/s)
# Kept as an array of separate entries (never joined with a shell `|` into
# one combined alternation string): a `|` used as both a delimiter and an
# alternation operator inside a pattern can silently abort the expression in
# some tools -- exiting 0 and looking like it ran while matching nothing.
# One pattern per array entry avoids that collision entirely.
#
# The case column exists because the two personal-attribution rules use an
# uppercase character class to mean "initials" / "a capitalised given name".
# Under a case-insensitive grep that class matches any letter, so the rules
# fired on ordinary English ("disagreed with the shipped code"). They run
# case-sensitively, with the leading letter spelled out as a class so a
# sentence-initial capital still matches.
RULES=(
  $'local-absolute-path-users\t(^|[^A-Za-z0-9_/])/Users/[A-Za-z0-9._-]+\t0\ti'
  $'local-absolute-path-home\t(^|[^A-Za-z0-9_/])/home/[A-Za-z0-9._-]+\t0\ti'
  $'tilde-rooted-path\t(^|[^A-Za-z0-9_~])~/[A-Za-z0-9._/-]+\t0\ti'
  $'bare-issue-ref\t(^|[^0-9A-Za-z/])#[0-9]{2,5}\\b\t0\ti'
  $'plus-alias-email\t[A-Za-z0-9._%-]+\\+[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\t0\ti'
  $'personal-attribution-agreed-with\t[Aa]greed with [A-Z]{2,4}\\b\t0\ts'
  $'personal-attribution-per-request\t[Pp]er [A-Z][a-z]+.s (request|call|note)\t0\ts'
)

RULE_COUNT="${#RULES[@]}"

# Single source of truth for grep flags. The canary and the real scan MUST
# run a rule under identical flags -- a canary that proves a rule works
# under flags the scan does not use is exactly the fail-open shape the
# canary exists to prevent -- so both call this and neither builds its own.
RULE_FLAGS=()
_rule_flags() { # $1=word-boundary(0/1) $2=case(i/s)
  RULE_FLAGS=(-rInE)
  [ "$2" = "i" ] && RULE_FLAGS+=(-i)
  [ "$1" = "1" ] && RULE_FLAGS+=(-w)
  return 0
}

# Known-bad seed for one rule, printed on stdout.
#
# Each seed is assembled from sub-fragments rather than written as a single
# contiguous literal. This script is copied verbatim into adopting repos and
# scanned along with everything else (the run step is fixed:
# `bash public-safe-lint.sh .`) -- a canary seed that appeared as a matchable
# literal in this file's own source would make the script flag itself on
# every adopting repo, permanently failing the required check even on an
# otherwise-clean tree. Splitting the fragments keeps the *assembled*
# runtime string a faithful known-bad seed while the source line itself is
# not one.
_seed_for() { # $1=rule name
  local a b
  case "$1" in
    local-absolute-path-users) a='/Us'; b='ers/exampleuser/scratch/file.txt' ;;
    local-absolute-path-home) a='/ho'; b='me/exampleuser/scratch/file.txt' ;;
    tilde-rooted-path) a='~'; b='/scratch/example-file.txt' ;;
    bare-issue-ref) a='bare ref #'; b='4321 with no qualifier' ;;
    plus-alias-email) a='tester'; b='+canary@example.com' ;;
    personal-attribution-agreed-with) a='agreed wi'; b='th TK on this' ;;
    personal-attribution-per-request) a='per Ali'; b="ce's request" ;;
    *) return 1 ;;
  esac
  echo "canary seed: ${a}${b}"
}

# --- Config: parse the sidecar file, if any.
DISABLED=()
EXTRA_EXCL=()
CONFIG_PATH=""

if [ -n "${PUBLIC_SAFE_LINT_CONFIG:-}" ]; then
  CONFIG_PATH="$PUBLIC_SAFE_LINT_CONFIG"
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "FAIL: PUBLIC_SAFE_LINT_CONFIG points at no such file: $CONFIG_PATH" >&2
    exit 1
  fi
elif [ -f "$ROOT/.public-safe-lint.conf" ]; then
  CONFIG_PATH="$ROOT/.public-safe-lint.conf"
fi

_is_rule_name() { # $1=candidate
  local r n
  for r in "${RULES[@]}"; do
    n="${r%%$'\t'*}"
    [ "$n" = "$1" ] && return 0
  done
  return 1
}

if [ -n "$CONFIG_PATH" ]; then
  _lineno=0
  while IFS= read -r _cfgline || [ -n "$_cfgline" ]; do
    _lineno=$((_lineno + 1))
    # trim leading/trailing whitespace
    _cfgline="${_cfgline#"${_cfgline%%[![:space:]]*}"}"
    _cfgline="${_cfgline%"${_cfgline##*[![:space:]]}"}"
    [ -z "$_cfgline" ] && continue
    case "$_cfgline" in \#*) continue ;; esac

    case "$_cfgline" in
      *=*) : ;;
      *)
        echo "FAIL: $CONFIG_PATH:$_lineno: not a 'key = value' line" >&2
        exit 1
        ;;
    esac
    _key="${_cfgline%%=*}"
    _val="${_cfgline#*=}"
    _key="${_key%"${_key##*[![:space:]]}"}"
    _val="${_val#"${_val%%[![:space:]]*}"}"

    case "$_key" in
      disable | exclude-dir | exclude) : ;;
      *)
        echo "FAIL: $CONFIG_PATH:$_lineno: unknown key '$_key' (expected: disable, exclude-dir, exclude)" >&2
        exit 1
        ;;
    esac

    _old_ifs="$IFS"
    IFS=','
    # `set -f` matters: a value legitimately contains globs (exclude = *.js)
    # and the unquoted split below would otherwise expand them against the
    # working directory instead of handing them to grep.
    set -f
    # shellcheck disable=SC2086
    set -- $_val
    set +f
    IFS="$_old_ifs"
    if [ "$#" -eq 0 ]; then
      echo "FAIL: $CONFIG_PATH:$_lineno: key '$_key' has an empty value" >&2
      exit 1
    fi
    for _item in "$@"; do
      _item="${_item#"${_item%%[![:space:]]*}"}"
      _item="${_item%"${_item##*[![:space:]]}"}"
      [ -z "$_item" ] && continue
      # Conservative charset. Config content is attacker-controlled on a
      # fork PR; every value below is passed to grep as one quoted argument,
      # and this class additionally forbids anything that could be read as
      # a further option or a shell metacharacter.
      case "$_item" in
        -*)
          echo "FAIL: $CONFIG_PATH:$_lineno: value '$_item' may not begin with '-'" >&2
          exit 1
          ;;
      esac
      if ! printf '%s' "$_item" | grep -qE '^[A-Za-z0-9._*?/-]+$'; then
        echo "FAIL: $CONFIG_PATH:$_lineno: value '$_item' contains characters outside [A-Za-z0-9._*?/-]" >&2
        exit 1
      fi
      case "$_key" in
        disable)
          if ! _is_rule_name "$_item"; then
            echo "FAIL: $CONFIG_PATH:$_lineno: '$_item' is not a rule name in $SCRIPT_NAME" >&2
            exit 1
          fi
          DISABLED+=("$_item")
          ;;
        exclude-dir) EXTRA_EXCL+=("--exclude-dir=$_item") ;;
        exclude) EXTRA_EXCL+=("--exclude=$_item") ;;
      esac
    done
  done <"$CONFIG_PATH"
fi

_is_disabled() { # $1=rule name
  local d
  for d in ${DISABLED[@]+"${DISABLED[@]}"}; do
    [ "$d" = "$1" ] && return 0
  done
  return 1
}

ACTIVE_RULES=()
for rule in "${RULES[@]}"; do
  _n="${rule%%$'\t'*}"
  _is_disabled "$_n" || ACTIVE_RULES+=("$rule")
done
ACTIVE_COUNT="${#ACTIVE_RULES[@]}"

if [ -n "$CONFIG_PATH" ]; then
  echo "config:          $CONFIG_PATH"
  if [ "${#DISABLED[@]}" -gt 0 ]; then
    echo "rules disabled:  $(
      IFS=','
      echo "${DISABLED[*]}"
    )"
  fi
  if [ "${#EXTRA_EXCL[@]}" -gt 0 ]; then
    echo "extra excludes:  ${EXTRA_EXCL[*]}"
  fi
fi

# Floor 1: a config may scope the scan down, never out.
if [ "$ACTIVE_COUNT" -eq 0 ]; then
  echo "FAIL: every rule is disabled -- a scan with no active rules is not a clean scan." >&2
  exit 1
fi

# --- Canary: before trusting a clean verdict, prove the scan path itself
# actually catches a known-bad seed FOR EVERY ACTIVE RULE. Guards two
# fail-open shapes: BSD sed's \b silently behaving as a no-op, and a
# '|'-joined alternation silently aborting the whole expression. Both exit 0
# and look like they ran. Per-rule (rather than "at least one rule matched")
# so that scoping the rule set down cannot leave the canary resting on a
# rule that is no longer part of the verdict.
_canary_dir="$(mktemp -d)"
trap 'rm -rf "$_canary_dir"' EXIT

_canary_matched=0
for rule in "${ACTIVE_RULES[@]}"; do
  IFS=$'\t' read -r _name _pattern _wb _case <<<"$rule"
  _seed_file="$_canary_dir/$_name.txt"
  if ! _seed_for "$_name" >"$_seed_file"; then
    echo "CANARY FAILED: no known-bad seed defined for rule '$_name' in $SCRIPT_NAME." >&2
    exit 1
  fi
  _rule_flags "$_wb" "$_case"
  if grep "${RULE_FLAGS[@]}" "$_pattern" "$_seed_file" >/dev/null 2>&1; then
    _canary_matched=$((_canary_matched + 1))
  else
    echo "CANARY FAILED: rule '$_name' did not match its own known-bad seed." >&2
    echo "The scan path itself is broken -- refusing to trust a clean verdict." >&2
    exit 1
  fi
done

if [ "$_canary_matched" -ne "$ACTIVE_COUNT" ]; then
  echo "CANARY FAILED: only $_canary_matched of $ACTIVE_COUNT active rule(s) matched a known-bad seed." >&2
  echo "The scan path itself is broken -- refusing to trust a clean verdict." >&2
  exit 1
fi
echo "canary: ok (known-bad seed matched by $_canary_matched of $ACTIVE_COUNT active rule(s))"
rm -rf "$_canary_dir"
trap - EXIT

# --- Real scan. file:line + rule name only -- never the matched text.
#
# `.git` is excluded both as a directory AND as a file glob: inside a git
# worktree, `.git` is not a directory but a FILE holding an absolute
# `gitdir:` pointer, which --exclude-dir does not skip and which then
# reports as a spurious local-absolute-path finding.
BASE_EXCL=(--exclude-dir=.git --exclude=.git --exclude-dir=node_modules)
FAIL=0
FILES_SCANNED="$(find "$ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"

for rule in "${ACTIVE_RULES[@]}"; do
  IFS=$'\t' read -r name pattern wb case_mode <<<"$rule"
  _rule_flags "$wb" "$case_mode"

  if hits=$(grep "${RULE_FLAGS[@]}" "$pattern" "$ROOT" \
    "${BASE_EXCL[@]}" ${EXTRA_EXCL[@]+"${EXTRA_EXCL[@]}"} 2>/dev/null); then
    FAIL=1
    while IFS= read -r hitline; do
      file_part="${hitline%%:*}"
      rest="${hitline#*:}"
      line_part="${rest%%:*}"
      echo "FAIL [$name]: ${file_part}:${line_part}"
    done <<<"$hits"
  fi
done

echo "== public-safe-lint coverage =="
if [ "$ACTIVE_COUNT" -eq "$RULE_COUNT" ]; then
  echo "rules evaluated: $ACTIVE_COUNT"
else
  echo "rules evaluated: $ACTIVE_COUNT of $RULE_COUNT"
fi
echo "files scanned:   $FILES_SCANNED"
echo "scan target:     $ROOT"

if [ "$FAIL" -ne 0 ]; then
  echo "verdict:         FAIL -- see FAIL lines above (file:line + rule name only)"
  exit 1
fi

echo "verdict:         clean against $ACTIVE_COUNT rule(s) over $FILES_SCANNED file(s)"
exit 0
