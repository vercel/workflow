#!/usr/bin/env bash
# Claude Code statusline helper for the `dev-tmux` skill.
#
# Reads `portless list` and emits a single line summarizing the active dev
# session for the current git worktree:
#
#     [dev]  [obs]  tmux:<worktree-prefix>
#
# `[dev]` and `[obs]` are OSC 8 hyperlinks (clickable in any modern
# terminal: iTerm2, Kitty, WezTerm, Terminal.app, Ghostty). The tmux
# indicator is shown when a session named exactly the worktree prefix
# exists (the dev-tmux skill creates one with that name).
#
# Wire it into ~/.claude/settings.json with the path pointing at your
# *primary* checkout — NOT a worktree, since worktrees get deleted:
#
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "$HOME/github/vercel/workflow/skills/dev-tmux/statusline.sh"
#     }
#   }
#
# Worktree-aware: uses Claude's `workspace.current_dir` (stdin JSON) to
# derive the current branch and filter portless routes / tmux sessions
# to the active worktree. With no input or no matching session/routes,
# the script prints nothing.

set -u

input=""
if [ ! -t 0 ]; then
  input=$(cat)
fi

cwd="${PWD}"
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  parsed_cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // empty' 2>/dev/null || true)
  [ -n "$parsed_cwd" ] && cwd="$parsed_cwd"
fi

# Resolve the worktree's portless prefix (basename of the branch — same
# convention `portless run` uses for linked worktrees, and the same name
# the dev-tmux skill assigns to its tmux session).
prefix=""
if command -v git >/dev/null 2>&1; then
  branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ -n "$branch" ] && [ "$branch" != "HEAD" ] && prefix="${branch##*/}"
fi

# Portless routes (silent if portless is missing or has nothing).
routes=""
if command -v portless >/dev/null 2>&1; then
  routes=$(portless list 2>/dev/null || true)
fi

pick_route() {
  local name="$1" url
  [ -z "$routes" ] && return
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

# Tmux session named exactly the worktree prefix.
session=""
if [ -n "$prefix" ] && command -v tmux >/dev/null 2>&1; then
  if tmux has-session -t "=$prefix" 2>/dev/null; then
    session="$prefix"
  fi
fi

# Bail quietly if there's nothing to show.
[ -z "$dev_url" ] && [ -z "$obs_url" ] && [ -z "$session" ] && exit 0

# OSC 8 hyperlink with underline + cyan, returning to dim afterwards.
# Format: ESC ] 8 ;; URL ESC \  TEXT  ESC ] 8 ;; ESC \
emit_link() {
  local url="$1" label="$2"
  printf '\033]8;;%s\033\\\033[4;36m%s\033[24;39m\033]8;;\033\\' "$url" "$label"
}

# Whole line is dim; link bodies brighten via emit_link.
printf '\033[2m'

first=1
sep() {
  if [ $first -eq 1 ]; then
    first=0
  else
    printf '  ·  '
  fi
}

if [ -n "$dev_url" ]; then
  sep
  emit_link "$dev_url" '[dev]'
fi
if [ -n "$obs_url" ]; then
  sep
  emit_link "$obs_url" '[obs]'
fi
if [ -n "$session" ]; then
  sep
  printf 'tmux:%s' "$session"
fi

printf '\033[0m\n'
