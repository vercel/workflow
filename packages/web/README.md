# @workflow/web

Observability Web UI Package bundled in the [Workflow SDK](https://workflow-sdk.dev/docs/observability).

## Self-hosting

> **Security notice:** The `@workflow/web` package does not include authentication or authorization.
> All users who can reach the deployment share the same backend credentials configured via environment variables.
> If you self-host this UI, you **must** place it behind your own authentication layer (e.g. VPN, reverse proxy with auth, OAuth).
> Exposing it to untrusted users without authentication is at your own risk and may allow unauthorized access to your workflow data.

While this UI is bundled with the Workflow CLI, you can also self-host it.

There are two approaches:

1. Run `npx workflow web --noBrowser` on a server
2. Run the published `@workflow/web` package's server directly

All options require the environment to be configured with the right environment variables for the World you're using.

### Allowed host names

To protect against DNS rebinding, the server rejects requests whose `Host` header is not `localhost`, a `*.localhost` name, or an IP address. If you reach the UI under a domain name (for example behind a reverse proxy), list it in `WORKFLOW_WEB_ALLOWED_HOSTS` or pass `--webAllowedHosts` to the CLI: comma-separated, `.example.com` matches the domain and its subdomains, and `*` disables the check. Cross-origin `POST` requests are rejected as well, unless their origin is one of these names.

### Option 1: Run with the CLI

```bash
npx workflow web --noBrowser --webAllowedHosts workflow.example.com
```

This will start the web UI on the default port `3456`.

### Option 2: Run the published `@workflow/web` package

The published `@workflow/web` package contains a prebuilt `build/` directory and a standalone server entry point, `server.js`.

```bash
npm i @workflow/web
PORT=3456 WORKFLOW_WEB_ALLOWED_HOSTS=workflow.example.com node node_modules/@workflow/web/server.js
```

### Configuration (environment variables)

The UI reads configuration on the server via environment variables.

- **Vercel (remote observability)**:
  - `WORKFLOW_TARGET_WORLD=vercel`
  - `WORKFLOW_VERCEL_TEAM`
  - `WORKFLOW_VERCEL_PROJECT`
  - `WORKFLOW_VERCEL_ENV` (optional; defaults to `production`)
  - `VERCEL_WORKFLOW_SERVER_URL` (optional; routes all Vercel analytics and primary-storage requests to a different workflow-server deployment)

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
