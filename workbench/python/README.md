# Python conformance workbench

This app runs the shared Workflow SDK e2e suite against the Python runtime. The
test driver and assertions remain in `packages/core/e2e/e2e.test.ts`; this
workbench supplies equivalent Python fixtures and exposes them through the same
manifest and workflow protocols as the JavaScript workbenches.

`vercel-workflow` is sourced from the `main` branch of
[vercel-py](https://github.com/vercel/vercel-py). `uv.lock` records the exact
commit used by local development, CI, and Vercel builds, so updating upstream
does not change this workbench until the lockfile is refreshed.

## Layout

- `workflows/99_e2e.py` contains the Python fixtures.
- `e2e-conformance.json` declares which fixtures and tests Python supports. It
  is a ratchet: a declared capability that disappears fails the suite instead
  of silently becoming skipped.
- The `99_e2e` module and its camelCase fixture functions intentionally match
  the TypeScript fixture path and exported names.
- `app.py` adapts the SDK's public HTTP handlers to bare ASGI.
- `pyproject.toml` selects the SDK source and the Vercel web/workflow
  entrypoints.
- `vercel.json` selects the platform Python builder and exposes the manifest.

## Run locally

Install the locked Python environment and start the app:

```bash
cd workbench/python
uv sync --locked
WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev
```

Then run the shared suite from the repository root:

```bash
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="python" \
  pnpm vitest run packages/core/e2e/e2e.test.ts
```

The app and TypeScript driver share the local World data directory, so the
TypeScript CLI can inspect runs created by Python:

```bash
cd workbench/python
node ./node_modules/workflow/bin/run.js inspect --json runs
```

## Update the Python SDK

Regenerate the lockfile to update the pinned `vercel-py/main` revision, then
rerun the suite:

```bash
cd workbench/python
rm uv.lock
uv lock
uv sync --locked
```

Remove `uv.lock` instead of using `--upgrade-package` due to a uv bug that can
switch transitive `vercel-*` dependencies from the `vercel-py` Git repository
to their PyPI releases during an incremental lock update.

## Vercel deployment

The `workbench-python-workflow` Vercel project is rooted at this directory and
is included in the `e2e-vercel-prod` matrix.

`vercel.json` selects the Python builder, while `pyproject.toml` declares the
ASGI web entrypoint and workflow registry. `.python-version` selects the
deployed Python version. Preview deployments use `VERCEL_WORKFLOW_SERVER_URL`
to target the same workflow server as the test driver.
