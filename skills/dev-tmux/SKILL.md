---
name: dev-tmux
description: Spin up a 3-pane tmux session for local Workflow SDK development — Next.js turbopack workbench, observability UI, and a scratchpad — all routed through portless so each worktree gets isolated `.localhost` URLs. Use when the user asks to "spin up the dev session", "start dev mode", "set up the workbench", or any time they want to test workflows interactively in a worktree alongside the observability UI.
metadata:
  author: Vercel Inc.
  version: '1.0'
---

# dev-tmux

Bootstraps a reusable 3-pane tmux session for end-to-end Workflow SDK development. Each pane is launched through [portless](https://github.com/aleclarson/portless) so the URLs are stable and worktree-scoped (e.g. `https://<branch>.turbopack.localhost`), avoiding port conflicts when multiple worktrees are running concurrently.

## Prerequisites

- `tmux` installed
- `portless` installed globally (`npm i -g portless` or via Homebrew). Verify with `portless --version`.
- Repo bootstrapped: `pnpm install && pnpm build`. The first run on a fresh worktree must complete both before any dev server can start (the workbench apps depend on built workspace packages — without `pnpm build` you get `MODULE_NOT_FOUND` for `workflow`).
- `WORKFLOW_PUBLIC_MANIFEST=1` is required on the dev server when running e2e tests against it (otherwise `/.well-known/workflow/v1/manifest` is gated).

## Layout

`main-vertical` layout — left pane is the dev server, the right column stacks the observability UI on top of a scratchpad shell:

```
+----------------------+--------------------------+
|                      |  pane 2: workflow web    |
|                      |  (observability UI       |
|  pane 1: turbopack   |   scoped to the          |
|  (Next.js dev)       |   workbench app)         |
|                      +--------------------------+
|                      |  pane 3: zsh scratchpad  |
|                      |  (repo root — for build, |
|                      |   tests, e2e, git, etc.) |
+----------------------+--------------------------+
```

## Setup

Pick a session name that does not collide with the user's existing sessions (run `tmux ls` first — never kill another session). The recommended name is `workflow-dev`, but if it is taken use `workflow-dev-<branch>`.

```bash
REPO=/path/to/workflow--<worktree-suffix>
SESSION=workflow-dev

tmux new-session -d -s "$SESSION" -c "$REPO"
tmux split-window -h -t "$SESSION" -c "$REPO"
tmux split-window -v -t "$SESSION" -c "$REPO"
tmux select-layout -t "$SESSION" main-vertical

# Pane 1 (left): Next.js turbopack workbench, with manifest exposed for e2e
tmux send-keys -t "$SESSION".1 \
  'cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 portless run --name turbopack pnpm dev' C-m

# Pane 2 (top-right): observability UI scoped to the workbench app
tmux send-keys -t "$SESSION".2 \
  'cd workbench/nextjs-turbopack && portless run --name workflow-obs sh -c "pnpm workflow web --webPort \$PORT --noBrowser"' C-m

# Pane 3 (bottom-right): scratchpad at repo root
tmux send-keys -t "$SESSION".3 'echo "scratchpad: $(pwd)"' C-m

tmux attach -t "$SESSION"
```

Once both servers are ready, `portless list` will show the routes. With `portless run`, each linked worktree gets a unique branch-prefixed subdomain (e.g. `stepflow-test.turbopack.localhost`), so multiple worktrees coexist without changing config.

## Why each piece

- **`portless run --name <name>`** (instead of `portless <name> <cmd>`): `run` auto-detects git worktrees and prepends the sanitized branch name as a subdomain. The `--name` flag overrides the inferred base name while preserving the worktree prefix.
- **`pnpm workflow web --webPort $PORT --noBrowser`** (instead of `pnpm dev` in `packages/web`): the bundled CLI starts the observability UI configured against the **current workbench app**, hydrating it with that project's local World data. Running `packages/web`'s own `dev` script gives you the UI but pointed at nothing.
- **`sh -c '... --webPort $PORT'`**: portless's auto `--port` injection only triggers for known frameworks it can detect on the command line. When the command is a CLI wrapper (`pnpm workflow web`), wrap in `sh -c` and read `$PORT` (which portless always sets) explicitly.
- **`WORKFLOW_PUBLIC_MANIFEST=1`** on pane 1: required for e2e tests to fetch the workflow registry from the dev server.

## Restarting after editing workflow files

The workflow manifest is built at dev-server startup. New workflows or steps added to `workbench/example/workflows/*.ts` (and their symlinks in other workbenches) **do not appear at runtime** — even with HMR — until the dev server restarts.

```bash
tmux send-keys -t workflow-dev.1 C-c
# Wait for the prompt to return
tmux send-keys -t workflow-dev.1 \
  'WORKFLOW_PUBLIC_MANIFEST=1 portless run --name turbopack pnpm dev' C-m
```

To verify the new workflow is registered, check the manifest endpoint (use the portless-assigned port from `portless list` for HTTP, or the `.localhost` URL with the trusted CA for HTTPS):

```bash
/usr/bin/curl -s "$(portless get turbopack)/.well-known/workflow/v1/manifest.json" \
  | grep -o 'sleepWinsRaceWorkflow\|<your-new-workflow>'
```

(`NODE_EXTRA_CA_CERTS=/tmp/portless/ca.pem` is needed for Node clients hitting the HTTPS URL outside of portless-managed children. Browsers are fine after `portless trust`.)

## Running e2e tests against this session

From pane 3 (scratchpad). Use the portless-assigned local port to bypass TLS for the test runner:

```bash
PORT=$(portless list | awk '/turbopack/ {sub(":","",$NF); print $NF}' | head -1)
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
tmux kill-session -t workflow-dev
```

Portless removes routes when each child process exits (Ctrl+C the panes first if you want a clean `portless list`). The proxy itself keeps running for other sessions; stop it explicitly with `portless proxy stop` if needed.

## Troubleshooting

- **`MODULE_NOT_FOUND: 'workflow'`** in pane 1 — workspace packages haven't been built. Run `pnpm build` from the repo root, then restart pane 1.
- **Observability UI shows no runs** — verify pane 2 was started from inside `workbench/nextjs-turbopack` (or whichever workbench you want to inspect). The CLI reads the local World from the **current working directory**.
- **react-router on `:5173` instead of the portless port** — happens when the obs pane uses `pnpm dev` from `packages/web`. Switch to the `pnpm workflow web --webPort $PORT` form above.
- **Source-map warning on startup** (`failed to read input source map ... packages/serde/dist/index.js.map`) — benign; doesn't block dev.
- **Stale workflow registration** after editing `99_e2e.ts` — restart pane 1; HMR doesn't rebuild the manifest.
