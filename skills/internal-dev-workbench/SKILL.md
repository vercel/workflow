---
name: internal-dev-workbench
description: Spin up a portless + tmux dev session for the Workflow SDK that gives each git worktree isolated `<branch>.<name>.localhost` URLs for the Next.js workbench and the observability UI, plus a Claude statusline that surfaces those URLs. Use only when the user asks for a "portless dev session", a "tmux dev layout for workflow", "worktree-isolated dev URLs", or wants to wire workflow dev URLs into the Claude statusline. Do not activate for the generic "start the dev server" / "run pnpm dev" task.
metadata:
  author: Pranay Prakash
  version: '0.1'
---

# internal-dev-workbench

Bootstraps an opinionated 3-pane tmux session for end-to-end Workflow SDK development. Each pane is launched through [portless](https://github.com/aleclarson/portless) so URLs are stable and worktree-scoped (e.g. `https://<branch>.turbopack.localhost`), letting multiple worktrees run concurrently without port conflicts. A companion statusline script surfaces the active URLs in Claude Code's prompt.

This is **opt-in contributor tooling**. The repo's standard dev path (`pnpm dev` from a workbench, no portless) is unaffected.

## Prerequisites

- `tmux` installed
- `portless` installed globally (`npm i -g portless` or via Homebrew). Verify with `portless --version`.
- Repo bootstrapped: `pnpm install && pnpm build`. The first run on a fresh worktree must complete both before any dev server can start (the workbench apps depend on built workspace packages — without `pnpm build` you get `MODULE_NOT_FOUND` for `workflow`).
- `WORKFLOW_PUBLIC_MANIFEST=1` is required on the dev server when running e2e tests against it (otherwise `/.well-known/workflow/v1/manifest.json` is gated).

## Layout

`main-vertical` — the dev server takes the left column; the right column stacks the observability UI on top of a scratchpad shell:

```
+----------------------+--------------------------+
|                      |  PANE_OBS: workflow web  |
|                      |  (observability UI       |
|  PANE_DEV: turbopack |   scoped to the          |
|  (Next.js dev)       |   workbench app)         |
|                      +--------------------------+
|                      |  PANE_SH: zsh scratchpad |
|                      |  (repo root — for build, |
|                      |   tests, e2e, git, etc.) |
+----------------------+--------------------------+
```

## Setup

The session name **must** match the worktree's portless prefix — the basename of the current branch — so the statusline (and any other tooling that derives the prefix from the branch) can locate it. Always run `tmux ls` first to confirm there's no pre-existing session with that name; never kill an existing one.

Pane indices in tmux depend on `pane-base-index` (0 by default, 1 with the common dotfile override). To stay correct under either, capture each pane's ID at split time with `-P -F '#{pane_id}'` and use those IDs as targets:

```bash
REPO=/path/to/workflow--<worktree-suffix>
# Session name = basename of the branch (matches portless's subdomain prefix
# and the statusline's `tmux attach -t <prefix>` indicator). For branch
# `pgp/foo-bar` this resolves to `foo-bar`.
SESSION=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
SESSION="${SESSION##*/}"

# Create the session and capture the initial pane ID
PANE_DEV=$(tmux new-session -d -s "$SESSION" -c "$REPO" -P -F '#{pane_id}')
PANE_OBS=$(tmux split-window -h -t "$PANE_DEV" -c "$REPO" -P -F '#{pane_id}')
PANE_SH=$(tmux split-window -v -t "$PANE_OBS" -c "$REPO" -P -F '#{pane_id}')
tmux select-layout -t "$SESSION" main-vertical

# Pane DEV (left): Next.js turbopack workbench, with manifest exposed for e2e
tmux send-keys -t "$PANE_DEV" \
  'cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 portless run --name turbopack pnpm dev' C-m

# Pane OBS (top-right): observability UI scoped to the workbench app
tmux send-keys -t "$PANE_OBS" \
  'cd workbench/nextjs-turbopack && portless run --name workflow-obs sh -c "pnpm workflow web --webPort \$PORT --noBrowser"' C-m

# Pane SH (bottom-right): scratchpad at repo root
tmux send-keys -t "$PANE_SH" 'echo "scratchpad: $(pwd)"' C-m

tmux attach -t "$SESSION"
```

Once both servers are ready, `portless list` shows the routes. With `portless run`, each linked worktree gets a unique branch-prefixed subdomain (e.g. `stepflow-test.turbopack.localhost`), so multiple worktrees coexist without changing config.

## Why each piece

- **`portless run --name <name>`** (instead of `portless <name> <cmd>`): `run` auto-detects git worktrees and prepends the sanitized branch name as a subdomain. The `--name` flag overrides the inferred base name while preserving the worktree prefix.
- **`pnpm workflow web --webPort $PORT --noBrowser`** (instead of `pnpm dev` in `packages/web`): the bundled CLI starts the observability UI configured against the **current workbench app**, hydrating it with that project's local World data. Running `packages/web`'s own `dev` script gives you the UI but pointed at nothing.
- **`sh -c '... --webPort $PORT'`**: portless's auto `--port` injection only triggers for known frameworks it can detect on the command line. When the command is a CLI wrapper (`pnpm workflow web`), wrap in `sh -c` and read `$PORT` (which portless always sets) explicitly.
- **`WORKFLOW_PUBLIC_MANIFEST=1`** on the dev pane: required for e2e tests to fetch the workflow registry from the dev server.
- **`-P -F '#{pane_id}'`**: makes the snippet correct regardless of the user's `pane-base-index` setting (defaults vary across configs).

## Claude statusline integration

The skill ships a statusline helper at `skills/internal-dev-workbench/statusline.sh` that derives the worktree prefix from the current branch and emits a compact line:

```
 dev  ·   obs  ·   tmux attach -t <worktree-prefix>
```

The dev / obs labels (Nerd Font rocket / graph glyphs) are OSC 8 hyperlinks — clickable in iTerm2, Kitty, WezTerm, Terminal.app, Ghostty — styled bold + underlined + bright cyan so they read unambiguously as links. The tmux fragment (Nerd Font copy glyph) is bold bright green, signaling "copy this" rather than "click this". It's shown only when a session named exactly the worktree prefix exists, and it's printed as a full ready-to-paste `tmux attach -t <prefix>` invocation. The font must include Nerd Font glyphs for the icons to render correctly; without them you'll see substitution boxes but the layout still works. Each piece is independent — if portless has no `<prefix>.turbopack.localhost` route, the dev fragment is omitted, and so on. With nothing to show, the script prints nothing and the statusline stays silent.

Wire it into `~/.claude/settings.json` so it works across all sessions and worktrees. **Point the path at your primary checkout, not at a worktree** — worktrees get deleted, so any path like `~/github/vercel/workflow--<branch>/...` will break the day you remove that worktree:

```json
{
  "statusLine": {
    "type": "command",
    "command": "$HOME/github/vercel/workflow/skills/internal-dev-workbench/statusline.sh"
  }
}
```

Adjust the prefix if your main checkout lives elsewhere. The script itself is worktree-aware: it reads Claude's `workspace.current_dir` from stdin to derive the current branch, so the *same script invocation* from `~/github/vercel/workflow/...` correctly surfaces routes for whichever worktree the Claude session is running in.

Output rules:
- Nothing to show (no matching portless route, no matching tmux session) → empty output.
- Each piece appears independently — start a server but no tmux session and you'll see just the dev/obs fragments; the reverse shows just the tmux fragment.
- No git context but routes exist → falls back to the first matching `turbopack`/`workflow-obs` route, no tmux indicator.

If you already use a statusline and want to append the internal-dev-workbench info, run the helper and concatenate in your existing wrapper script instead of replacing `command` outright.

## Restarting after editing workflow files

The workflow manifest is built at dev-server startup. New workflows or steps added to `workbench/example/workflows/*.ts` (and their symlinks in other workbenches) **do not appear at runtime** — even with HMR — until the dev server restarts.

```bash
tmux send-keys -t "$PANE_DEV" C-c
# Wait for the prompt to return
tmux send-keys -t "$PANE_DEV" \
  'cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 portless run --name turbopack pnpm dev' C-m
```

Verify the new workflow is registered (use the portless-assigned local port from `portless list`, or the `.localhost` URL with the trusted CA):

```bash
/usr/bin/curl -s "$(portless get turbopack)/.well-known/workflow/v1/manifest.json" \
  | grep -o '<your-new-workflow>'
```

`NODE_EXTRA_CA_CERTS=/tmp/portless/ca.pem` is needed for Node clients hitting the HTTPS URL outside of portless-managed children. Browsers are fine after `portless trust`.

## Running e2e tests against this session

From the scratchpad pane. Use the portless-assigned local port to bypass TLS for the test runner:

```bash
PORT=$(portless list | awk '/turbopack/ {n=split($3,a,":"); print a[n]; exit}')
DEPLOYMENT_URL="http://localhost:$PORT" APP_NAME="nextjs-turbopack" \
  pnpm vitest run packages/core/e2e/e2e.test.ts -t "<test name>"
```

Or use the portless URL with the CA trust:

```bash
NODE_EXTRA_CA_CERTS=/tmp/portless/ca.pem \
  DEPLOYMENT_URL="$(portless get turbopack)" APP_NAME="nextjs-turbopack" \
  pnpm vitest run packages/core/e2e/e2e.test.ts -t "<test name>"
```

## Teardown

```bash
tmux kill-session -t "$SESSION"
```

Portless removes routes when each child process exits (Ctrl+C the panes first if you want a clean `portless list`). The proxy itself keeps running for other sessions; stop it explicitly with `portless proxy stop` if needed.

## Troubleshooting

- **`MODULE_NOT_FOUND: 'workflow'`** in the dev pane — workspace packages haven't been built. Run `pnpm build` from the repo root, then restart the pane.
- **Observability UI shows no runs** — verify the obs pane was started from inside `workbench/nextjs-turbopack` (or whichever workbench you want to inspect). The CLI reads the local World from the **current working directory**.
- **react-router on `:5173` instead of the portless port** — happens when the obs pane uses `pnpm dev` from `packages/web`. Switch to the `pnpm workflow web --webPort $PORT` form above.
- **Source-map warning on startup** (`failed to read input source map ... packages/serde/dist/index.js.map`) — benign; doesn't block dev.
- **Stale workflow registration** after editing `99_e2e.ts` — restart the dev pane; HMR doesn't rebuild the manifest.
- **Statusline shows nothing** — confirm `portless list` has at least one matching route, the path in `settings.json` is absolute, and the script is executable (`chmod +x`).
