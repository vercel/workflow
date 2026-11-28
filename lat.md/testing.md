# Testing

Core package tests and end-to-end suites validate workflows through workbench applications.

## Core package testing

Core package and end-to-end test commands cover local and deployed workbench applications.

```bash
# Test core functionality
cd packages/core && pnpm test

# Test specific file
cd packages/core && pnpm vitest run src/[filename].test.ts

# Run E2E tests (requires environment variables and running dev server)
# Note: Use nextjs-turbopack for local e2e testing (not example app - it has no dev server)

# Step 1: Start the dev server in background
# NOTE: WORKFLOW_PUBLIC_MANIFEST=1 is required for e2e tests to access the workflow manifest
# NOTE: WORKFLOW_QUEUE_AUTH=off matches the e2e-local CI lanes, which keep
# queue auth off until the team decides to run them with it on. It is refused
# while dynamic workflows are enabled; the dynamic-workflow e2e runs with auth
# on and starts its runs through the app (see the header of
# packages/core/e2e/e2e-dynamic-workflow.test.ts).
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 WORKFLOW_QUEUE_AUTH=off pnpm dev > /tmp/nextjs-dev.log 2>&1 &

# Step 2: Wait for server to be ready (usually 15-20 seconds)
sleep 15

# Step 3: Run the e2e tests from the project root
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts

# Step 4: Stop the dev server when done
pkill -f "pnpm dev"

# To run specific tests, use the -t flag:
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts -t "sleeping"

# For running E2E locally against a deployed Vercel preview/production app:
# The test matrix in .github/workflows/tests.yml is the source of truth —
# each app entry defines the project-id / project-slug needed below.
#
# Required environment variables (matches the CI `e2e-vercel-prod` job):
# - DEPLOYMENT_URL: Full URL of the deployed app (e.g. a preview deployment URL)
# - VERCEL_DEPLOYMENT_ID: The dpl_... ID of the deployment (get via `vercel inspect <url>`)
# - APP_NAME: App name (example, nextjs-turbopack, nextjs-webpack, nitro, vite,
#             nuxt, sveltekit, hono, express, fastify, astro)
# - WORKFLOW_VERCEL_ENV: "preview" or "production"
# - WORKFLOW_VERCEL_AUTH_TOKEN: Vercel auth token with access to the team
# - WORKFLOW_VERCEL_TEAM: Vercel team ID (CI uses team_nO2mCG4W8IxPIeKoSsqwAxxB for labs)
# - WORKFLOW_VERCEL_PROJECT: Vercel project ID (prj_...) — see test matrix
# - WORKFLOW_VERCEL_PROJECT_SLUG: Vercel project slug — see test matrix
# - VERCEL_OIDC_TOKEN:         Short-lived OIDC token used to bypass
#                              deployment protection via Trusted Sources.
#                              In CI this is auto-minted from the GitHub
#                              Actions runner. Locally, run
#                              `vercel env pull` from any workbench app's
#                              directory and the resulting `.env.local`
#                              will contain a `VERCEL_OIDC_TOKEN` value
#                              that all workbench projects accept (they
#                              are configured to trust each other under
#                              `trustedSources.projects`).
#
# Example (nextjs-turbopack preview deployment):
NODE_OPTIONS="--enable-source-maps" \
DEPLOYMENT_URL="https://example-nextjs-workflow-turbopack-<hash>.labs.vercel.dev" \
VERCEL_DEPLOYMENT_ID="dpl_..." \
APP_NAME="nextjs-turbopack" \
WORKFLOW_VERCEL_ENV="preview" \
WORKFLOW_VERCEL_AUTH_TOKEN="<vercel_labs_token>" \
WORKFLOW_VERCEL_TEAM="team_nO2mCG4W8IxPIeKoSsqwAxxB" \
WORKFLOW_VERCEL_PROJECT="prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi" \
WORKFLOW_VERCEL_PROJECT_SLUG="example-nextjs-workflow-turbopack" \
VERCEL_OIDC_TOKEN="$(grep VERCEL_OIDC_TOKEN workbench/nextjs-turbopack/.env.local | cut -d= -f2-)" \
pnpm run test:e2e
```
