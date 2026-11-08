#!/usr/bin/env bash
# Fail when any commit in <base>..<head> was authored or committed by
# Cursor Agent, or carries a Cursor Co-authored-by trailer.
#
# Usage: block-cursor-authors.sh <base-rev> <head-rev>
#
# Block patterns (Cursor only):
# 1. Author or committer email equals cursoragent@cursor.com
#    (ASCII case-insensitive, surrounding whitespace trimmed).
# 2. Author or committer name equals "Cursor Agent"
#    (ASCII case-insensitive, surrounding whitespace trimmed,
#    internal whitespace collapsed to a single space).
# 3. A commit-message line whose trailer key is Co-authored-by
#    (ASCII case-insensitive, surrounding whitespace ignored) and whose
#    value mentions cursoragent@cursor.com as a full email token, or the
#    phrase "Cursor Agent" (ASCII case-insensitive, whitespace collapsed).

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: block-cursor-authors.sh <base-rev> <head-rev>" >&2
  exit 2
fi

base="$1"
head="$2"
cursor_email="cursoragent@cursor.com"
cursor_name="cursor agent"

if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "::error::Base revision not found: ${base}"
  exit 1
fi
if ! git rev-parse --verify --quiet "${head}^{commit}" >/dev/null; then
  echo "::error::Head revision not found: ${head}"
  exit 1
fi

normalize_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+/ /g'
}

normalize_email() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

append_reason() {
  if [ -n "$reasons" ]; then
    reasons="${reasons}; $1"
  else
    reasons="$1"
  fi
}

trailer_mentions_cursor() {
  local body="$1"
  local line lower trimmed value collapsed

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    lower="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    trimmed="$(printf '%s' "$lower" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    case "$trimmed" in
      co-authored-by:*)
        value="${trimmed#co-authored-by:}"
        value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        if printf '%s\n' "$value" \
          | grep -E -a -o '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' \
          | grep -F -x -q "$cursor_email"; then
          return 0
        fi
        collapsed="$(printf '%s' "$value" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
        if printf '%s\n' "$collapsed" | grep -E -a -q '(^|[^a-z])cursor agent([^a-z]|$)'; then
          return 0
        fi
        ;;
    esac
  done <<< "$body"
  return 1
}

echo "Checking ${base}..${head}"

blocked=0
count=0
offending=()
reasons=""
shas="$(git rev-list "${base}..${head}")"

while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  count=$((count + 1))
  reasons=""

  meta="$(git --no-pager show -s --no-notes --format='%an%x1f%ae%x1f%cn%x1f%ce' "$sha")"
  IFS=$'\x1f' read -r author_name author_email committer_name committer_email <<< "$meta"
  body="$(git --no-pager show -s --no-notes --format='%B' "$sha")"

  if [ "$(normalize_email "$author_email")" = "$cursor_email" ]; then
    append_reason "author email matches cursoragent@cursor.com"
  fi
  if [ "$(normalize_name "$author_name")" = "$cursor_name" ]; then
    append_reason "author name matches Cursor Agent"
  fi
  if [ "$(normalize_email "$committer_email")" = "$cursor_email" ]; then
    append_reason "committer email matches cursoragent@cursor.com"
  fi
  if [ "$(normalize_name "$committer_name")" = "$cursor_name" ]; then
    append_reason "committer name matches Cursor Agent"
  fi
  if trailer_mentions_cursor "$body"; then
    append_reason "Co-authored-by trailer mentions Cursor Agent"
  fi

  if [ -n "$reasons" ]; then
    blocked=1
    offending+=("$sha")
    echo "::error::${sha} blocked (${reasons})"
  fi
done <<< "$shas"

if [ "$blocked" -eq 1 ]; then
  echo "::error::Cursor Agent authorship blocked. Offending commits: ${offending[*]}. Fix: git rebase / git commit --amend --reset-author / strip the Co-authored-by trailer, then force-push the PR branch."
  exit 1
fi

echo "Authors are clean (${count} commit(s) checked)."
