#!/usr/bin/env bash
# Claude Code statusline helper for the `internal-dev-workbench` skill.
#
# Reads `portless list` and emits a single line summarizing the active dev
# session for the current git worktree:
#
#      dev   ·   obs   ·   tmux attach -t <worktree-prefix>
#
# ` dev` and ` obs` are OSC 8 hyperlinks (clickable in any modern
# terminal: iTerm2, Kitty, WezTerm, Terminal.app, Ghostty), styled bold +
# underlined + bright cyan. The tmux fragment is shown when a session
# named exactly the worktree prefix exists, in bold bright green to
# signal "copy this" rather than "click this". Nerd Font glyphs are used
# for the leading icons.
#
# Wire it into ~/.claude/settings.json with the path pointing at your
# *primary* checkout — NOT a worktree, since worktrees get deleted:
#
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "$HOME/github/vercel/workflow/skills/internal-dev-workbench/statusline.sh"
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
# the internal-dev-workbench skill assigns to its tmux session).
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

# OSC 8 hyperlink, styled bold + underlined + bright cyan so it reads as
# a clickable link. Each emission resets its own styling so callers don't
# need to re-establish color state.
emit_link() {
  local url="$1" label="$2"
  printf '\033]8;;%s\033\\\033[1;4;96m%s\033[0m\033]8;;\033\\' "$url" "$label"
}

# Bright green tmux command — visually distinct from the cyan-underline
# links; signals "copy this" rather than "click this". The copy-glyph
# icon is sourced from the ICON_CP variable defined below to avoid the
# Nerd Font byte being stripped by editors that don't preserve the
# Private Use Area.
emit_tmux() {
  printf '\033[1;92m%s tmux attach -t %s\033[0m' "${ICON_CP}" "$1"
}

# Bold separator so it reads at the same weight as the surrounding tokens.
emit_sep() {
  printf '\033[1m  ·  \033[0m'
}

first=1
sep() {
  if [ $first -eq 1 ]; then
    first=0
  else
    emit_sep
  fi
}

# Nerd Font glyphs (octicon rocket, octicon graph, fa copy) embedded as
# Unicode escapes so the source survives any encoding round-trip.
ICON_DEV=$''
ICON_OBS=$''
ICON_CP=$''

if [ -n "$dev_url" ]; then
  sep
  emit_link "$dev_url" "${ICON_DEV} dev"
fi
if [ -n "$obs_url" ]; then
  sep
  emit_link "$obs_url" "${ICON_OBS} obs"
fi
if [ -n "$session" ]; then
  sep
  emit_tmux "$session"
fi

printf '\n'
