#!/usr/bin/env bash
# Claude Code statusline helper for the `dev-tmux` skill.
#
# Reads `portless list` and emits a single line containing the active dev
# server and observability URLs (filtered to the current git worktree when
# possible). Designed to be wired into ~/.claude/settings.json:
#
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "/abs/path/to/skills/dev-tmux/statusline.sh"
#     }
#   }
#
# Claude passes a small JSON blob on stdin describing the session; we use
# `workspace.current_dir` (when present) to derive the worktree branch and
# filter routes. With no input or no portless routes, the script prints
# nothing — a blank statusline is the right behavior when no dev session
# is running.

set -u

# Discard Claude's stdin payload but capture cwd if provided.
input=""
if [ ! -t 0 ]; then
  input=$(cat)
fi

cwd="${PWD}"
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  parsed_cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // empty' 2>/dev/null || true)
  [ -n "$parsed_cwd" ] && cwd="$parsed_cwd"
fi

# Resolve the worktree's portless prefix (basename of the branch — matches
# how `portless run` derives the subdomain for linked worktrees).
prefix=""
if command -v git >/dev/null 2>&1; then
  branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ -n "$branch" ] && [ "$branch" != "HEAD" ] && prefix="${branch##*/}"
fi

# Bail quietly if portless isn't installed or has no routes.
command -v portless >/dev/null 2>&1 || exit 0
routes=$(portless list 2>/dev/null) || exit 0

# Pick the first route matching `<prefix>.<name>.localhost` if a prefix is
# known, otherwise fall back to the first `<name>.localhost` match. This
# handles both worktree-prefixed and bare names without losing output when
# a route exists but the cwd isn't a git checkout.
pick_route() {
  local name="$1" url
  if [ -n "$prefix" ]; then
    url=$(printf '%s\n' "$routes" \
      | awk -v p="$prefix" -v n="$name" \
            '$1 ~ ("https?://"p"\\."n"\\.localhost") {print $1; exit}')
    [ -n "$url" ] && { printf '%s' "$url"; return; }
  fi
  printf '%s\n' "$routes" \
    | awk -v n="$name" '$1 ~ ("https?://([^.]+\\.)?"n"\\.localhost") {print $1; exit}'
}

dev_url=$(pick_route turbopack)
obs_url=$(pick_route workflow-obs)

parts=()
[ -n "$dev_url" ] && parts+=("dev: $dev_url")
[ -n "$obs_url" ] && parts+=("obs: $obs_url")

[ ${#parts[@]} -eq 0 ] && exit 0

printf '%s' "${parts[0]}"
for p in "${parts[@]:1}"; do
  printf '  ·  %s' "$p"
done
printf '\n'
