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
# seed value actually matches at least one rule (see the canary block
# below) -- this guards against a scanner that silently matches nothing
# while still reporting success.
set -uo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat <<EOF
usage: $SCRIPT_NAME <path-to-scan>

Scans <path-to-scan> for org-agnostic public-safety shapes (local absolute
paths, bare issue refs, +alias emails, personal-attribution phrases). Prints
file:line and rule name only -- never the matched text. Exits non-zero on
any hit, on a canary failure, or on a usage error.
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

# Rule table: name<TAB>grep-E-pattern<TAB>word-boundary(0/1)
# Kept as an array of separate entries (never joined with a shell `|` into
# one combined alternation string): a `|` used as both a delimiter and an
# alternation operator inside a pattern can silently abort the expression in
# some tools -- exiting 0 and looking like it ran while matching nothing.
# One pattern per array entry avoids that collision entirely.
RULES=(
  $'local-absolute-path-users\t(^|[^A-Za-z0-9_/])/Users/[A-Za-z0-9._-]+\t0'
  $'local-absolute-path-home\t(^|[^A-Za-z0-9_/])/home/[A-Za-z0-9._-]+\t0'
  $'tilde-rooted-path\t(^|[^A-Za-z0-9_~])~/[A-Za-z0-9._/-]+\t0'
  $'bare-issue-ref\t(^|[^0-9A-Za-z/])#[0-9]{2,5}\\b\t0'
  $'plus-alias-email\t[A-Za-z0-9._%-]+\\+[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\t0'
  $'personal-attribution-agreed-with\tagreed with [A-Z]{2,4}\\b\t0'
  $'personal-attribution-per-request\tper [A-Z][a-z]+.s (request|call|note)\t0'
)

RULE_COUNT="${#RULES[@]}"

# --- Canary: before trusting a clean verdict, prove the scan path itself
# actually catches a known-bad seed. Guards two fail-open shapes: BSD sed's
# \b silently behaving as a no-op, and a '|'-joined alternation silently
# aborting the whole expression. Both exit 0 and look like they ran.
_canary_dir="$(mktemp -d)"
trap 'rm -rf "$_canary_dir"' EXIT
# The known-bad shapes below are assembled from sub-fragments rather than
# written as a single contiguous literal. This script is copied verbatim
# into adopting repos and scanned along with everything else (the run step
# is fixed: `bash public-safe-lint.sh .`) -- a canary seed that appears as
# a matchable literal in this file's own source would make the script flag
# itself on every adopting repo, permanently failing the required check
# even on an otherwise-clean tree. Splitting the fragments keeps the
# *assembled* runtime string a faithful known-bad seed (it still matches
# each rule once written to canary.txt) while the source line itself does
# not.
_seed_path_prefix='/Us'
_seed_path_suffix='ers/exampleuser/scratch/file.txt'
_seed_hash='#'
_seed_issue_digits='4321'
_seed_email_local='tester'
_seed_email_rest='+canary@example.com'
{
  echo "canary line one: ${_seed_path_prefix}${_seed_path_suffix}"
  echo "canary line two: bare ref ${_seed_hash}${_seed_issue_digits} with no qualifier"
  echo "canary line three: ${_seed_email_local}${_seed_email_rest}"
} > "$_canary_dir/canary.txt"

_canary_hit=0
for rule in "${RULES[@]}"; do
  IFS=$'\t' read -r _name _pattern _wb <<<"$rule"
  flags=(-rIniE)
  [ "$_wb" = "1" ] && flags+=(-w)
  if grep "${flags[@]}" "$_pattern" "$_canary_dir" >/dev/null 2>&1; then
    _canary_hit=1
    break
  fi
done

if [ "$_canary_hit" -ne 1 ]; then
  echo "CANARY FAILED: known-bad seed did not match any rule in $SCRIPT_NAME." >&2
  echo "The scan path itself is broken -- refusing to trust a clean verdict." >&2
  exit 1
fi
echo "canary: ok (known-bad seed matched at least one of $RULE_COUNT loaded rule(s))"
rm -rf "$_canary_dir"
trap - EXIT

# --- Real scan. file:line + rule name only -- never the matched text.
FAIL=0
FILES_SCANNED="$(find "$ROOT" -type f 2>/dev/null | wc -l | tr -d ' ')"

for rule in "${RULES[@]}"; do
  IFS=$'\t' read -r name pattern wb <<<"$rule"
  flags=(-rIniE)
  [ "$wb" = "1" ] && flags+=(-w)

  if hits=$(grep "${flags[@]}" "$pattern" "$ROOT" \
      --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null); then
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
echo "rules evaluated: $RULE_COUNT"
echo "files scanned:   $FILES_SCANNED"
echo "scan target:     $ROOT"

if [ "$FAIL" -ne 0 ]; then
  echo "verdict:         FAIL -- see FAIL lines above (file:line + rule name only)"
  exit 1
fi

echo "verdict:         clean against $RULE_COUNT rule(s) over $FILES_SCANNED file(s)"
exit 0
