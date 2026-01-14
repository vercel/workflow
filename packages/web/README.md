# @workflow/web

Observability Web UI Package bundled in the [Workflow DevKit](https://useworkflow.dev/docs/observability).

## Self-hosting

While this UI is bundled with the Workflow CLI, you can also self-host it.

There are multiple approaches:

1. Run `npx workflow web --noBrowser` on a server
2. Clone this repo and deploy as a normal Next.js app
3. Deploy the published `@workflow/web` package

All options require the environment to be configured with the right environment variables for the World you're using.

### Option 1: Run with the CLI

```bash
npx workflow web --noBrowser
```

This will start the web UI on the default port `3456`.

### Option 2: Clone and deploy

- Build and deploy like any Next.js app.
- Configure the backend via environment variables (same variables the CLI writes).

### Option 3: Deploy the published `@workflow/web` package

The published `@workflow/web` package contains a prebuilt `.next` directory and `package.json`.
You can install it and run `next start` from the package directory.

Example (Node server / container):

```bash
mkdir workflow-observability-ui
cd workflow-observability-ui

npm init -y
# You must provide React runtime dependencies in your host project.
npm i @workflow/web react react-dom

# Run Next.js from the installed package (it contains the .next output)
cd node_modules/@workflow/web
npx --yes next start -p "${PORT:-3456}"
```

If you prefer, you can set a `start` script in your host `package.json` like:

```json
{
  "scripts": {
    "start": "cd node_modules/@workflow/web && next start -p $PORT"
  }
}
```

### Configuration (environment variables)

The UI reads configuration on the server via environment variables.

- **Vercel (remote observability)**:
  - `WORKFLOW_TARGET_WORLD=vercel`
  - `WORKFLOW_VERCEL_TEAM`
  - `WORKFLOW_VERCEL_PROJECT`
  - `WORKFLOW_VERCEL_ENV` (optional; defaults to `production`)

- **Local (filesystem-backed observability)**:
  - `WORKFLOW_TARGET_WORLD=local`
  - `WORKFLOW_LOCAL_DATA_DIR` (absolute path to the workflow data dir, e.g. `/path/to/project/.workflow-data`)
  - `WORKFLOW_MANIFEST_PATH` (optional; enables the Graph tab)

- **Postgres**:
  - `WORKFLOW_TARGET_WORLD=postgres`
  - `WORKFLOW_POSTGRES_URL`

For a complete list and CLI flags, see `npx workflow inspect --help` and `npx workflow web --help`.

If you're deploying this to Vercel, setting `WORKFLOW_TARGET_WORLD` to `vercel` is enough
for the server to infer your other project details at runtime. Note that observability will be scoped to the project and environment you're deploying to.
