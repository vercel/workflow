# Agent instructions

**CRITICAL RULES:**
- NEVER push directly to the `main` or `stable` branches
- Do not remove or break agent-discoverable docs sitemap behavior: keep docs/app/sitemap.md/route.ts and docs/app/[lang]/sitemap.md/route.ts, and keep the sitemap link in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts.

## Overview

Workflow SDK is a durable functions framework for JavaScript/TypeScript that enables writing long-running, stateful application logic on top of stateless compute. The runtime persists progress as an event log and deterministically replays code to reconstruct state after cold starts, failures, or scale events.

This repository contains the client-side SDK code for workflows, along with example apps that showcase Workflow SDK in action.

## Architecture

### Core components

- **packages/core**: Core workflow runtime and primitives (`@workflow/core`)
- **packages/next**: Next.js integration (`@workflow/next`)
- **packages/cli**: Command-line interface (`@workflow/cli`)
- **packages/world**: Core interfaces and types for workflow storage backends (`@workflow/world`)
- **packages/world-local**: Filesystem-based workflow backend for local development and testing (`@workflow/world-local`)
- **packages/world-vercel**: Production workflow backend for Vercel platform deployments (`@workflow/world-vercel`)
- **packages/swc-plugin-workflow**: SWC compiler plugin for workflow transformations
- **workbench/example**: Basic workflow examples using the CLI (aka "standalone mode")
- **workbench/nextjs-turbopack**: Workflow examples using the Next.js integration

### Workflow execution model

Workflows consist of two types of functions:

1. **Workflow functions** (`"use workflow"`): Orchestrators that run in a sandboxed VM without full Node.js access
2. **Step functions** (`"use step"`): Individual pieces of logic with full Node.js runtime access

The framework uses compiler transformations to split workflow files into separate bundles for client, workflow, and step execution contexts.

## Development commands

### Workspace-level commands

```bash
# Build all packages
pnpm build

# Run tests across all packages  
pnpm test

# Run end-to-end tests
pnpm test:e2e

# Format code with Biome
pnpm format

# Lint with Biome
pnpm lint

# Typecheck TypeScript
pnpm typecheck

# Clean build artifacts
pnpm clean
```

### Core package testing

```bash
# Test core functionality
cd packages/core && pnpm test

# Test specific file
cd packages/core && pnpm vitest run src/[filename].test.ts

# Run E2E tests (requires environment variables and running dev server)
# Note: Use nextjs-turbopack for local e2e testing (not example app - it has no dev server)

# Step 1: Start the dev server in background
# NOTE: WORKFLOW_PUBLIC_MANIFEST=1 is required for e2e tests to access the workflow manifest
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev > /tmp/nextjs-dev.log 2>&1 &

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

### Event log race repro

`packages/core/e2e/event-log-race-repro.test.ts` is a dedicated harness for
`CORRUPTED_EVENT_LOG`. It drives three scenarios against one deployment:
`step-storm` and `hook-storm` (concurrent replays of a single run racing the
per-branch watchdog; `hook-storm` is the production shape), plus a `hook-sleep`
control that provides the calibration baseline. Any outcome other than
`completed` fails the run, except `infra`, which means the harness could not
reach the deployment.

Run it against a locally started workbench app. No Vercel deployment or
credentials are required:

```bash
pnpm run test:e2e:event-log-race-repro:local              # world-postgres
pnpm run test:e2e:event-log-race-repro:local --world local # world-local
```

The script (`scripts/event-log-race-repro-local.sh`, `--help` for flags) builds
and starts `workbench/nextjs-turbopack` with `WORKFLOW_TARGET_WORLD` and
`WORKFLOW_PUBLIC_MANIFEST=1` set **at build time** (both are build-time inputs;
missing either silently yields a default-world app or a 404 manifest), runs the
harness, prints the same summary table CI posts, and tears the server down. For
world-postgres it first brings up the container and applies migrations, and
leaves Postgres running for the next iteration unless `--teardown` is passed;
the container flags (`--skip-db-setup`, `--no-docker`, `--teardown`) do nothing
under `--world local`, whose only state is a data directory the script clears
before each run.

Run both worlds because neither subsumes the other: world-postgres
arbitrates event slots inside one SQL statement, while world-local arbitrates
them with an exclusive `link(2)` against a directory that two processes (the app
and the harness) both write to. A slot race a transaction closes is not
automatically closed by a filesystem.

Scale is controlled entirely by `EVENT_LOG_RACE_REPRO_*` environment variables.
Their defaults live only in `event-log-race-repro.test.ts`; neither the CI
workflow nor the local script defines a second copy. The default scale (14 runs)
is a per-PR regression check, not a rate measurement; a clean run means "the
storms did not trip it", not "the rate is below X". To soak for a *rate*, use the
historical scale:

```bash
EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS=600 \
EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS=600 \
EVENT_LOG_RACE_REPRO_ATTEMPTS=200 \
EVENT_LOG_RACE_REPRO_CONCURRENCY=40 \
EVENT_LOG_RACE_REPRO_BUDGET_MS=4500000 \
  pnpm run test:e2e:event-log-race-repro:local --skip-build --skip-db-setup
```

Against world-postgres the storms bite much harder than the CI job's Vercel
preview does: on `main`, three 14-run passes failed 8 of their 18 `step-storm`
attempts with `CORRUPTED_EVENT_LOG` while `hook-storm` and `hook-sleep` stayed
clean, so the script exits non-zero. That is the harness working, not a broken
setup, and it is why the local runner is the fast signal while a fix is in
flight. At 14 runs, a green CI job means "the storms did not trip it", nowhere
near "the rate is below X".

That is a *laptop* result, and the distinction matters: `CORRUPTED_EVENT_LOG`
means the run finished the race, while `stuck` usually means it never got to
run one. Two dispatches of the local lanes against unmodified `main` on GitHub's
4-core runners scored, at the default scale, world-postgres 5-6 of 6 `step-storm`
runs `stuck` at `runTimeoutMs` in both, and world-local 6 and 12 of 14 `stuck`.
The *same* lane, the same commit, "6/14" and "12/14" one dispatch apart. Read a
single local-lane number as a verdict on a PR and it will mislead you; read
`pressure.resumesSent` and `progress.events` in the results JSON instead, which
say whether the run was racing or starving.

Two properties of the harness made that starvation self-sustaining, and both are
now bounded. If you change either, know what you are giving up:

* **The poke pump is capped** (`EVENT_LOG_RACE_REPRO_POKE_MAX`, default 64).
  `step-storm`'s pressure is a wall-clock cadence, so a slow run collected *more*
  out-of-band writes per unit of progress than a fast one, and each one appends a
  `hook_received` that every later replay re-reads. Unbounded on a 4-core runner
  that reached approximately 270 pokes per run and no run ever finished; a healthy
  6-round run sends 35-41, so the cap clips runaways only.
* **Runs abandoned at `runTimeoutMs` are canceled.** They used to keep replaying
  in the same app process for the rest of the job. That is how world-local's
  `hook-storm` came to report six `stuck` runs with `resumesSent: 0`. Every one
  of them starved behind the previous scenario's six abandoned `step-storm` runs
  and never created a hook for the driver to resume, so the scenario measured
  nothing about hooks at all.

One difference affects how you read a local result: in CI each replay gets its
own Fluid invocation, while here every replay
of every run shares one Next.js process. world-postgres gives that process (and
the harness process) 50 embedded Graphile Worker slots each, and approximately
100 replays in one heap saturates GC. Measured on a 12-core laptop, all 14
attempts came back
`stuck` with the server at 6.4 GB RSS and Postgres idle. The script therefore
sets `WORKFLOW_POSTGRES_WORKER_CONCURRENCY=10` (override by exporting it) and
raises the app's old-space limit (`--heap-mb`). If a local run reports `stuck`
rather than `CORRUPTED_EVENT_LOG`, suspect the machine before the SDK.
world-local saturates the same single process from its own in-process queue,
which defaults to 1,000 deliveries in flight, so the script holds it at the same
number via `WORKFLOW_LOCAL_QUEUE_CONCURRENCY`.

world-local's storms come out clean far more often than world-postgres's, so the
default scale says even less there: the corruption it does produce needs a
`hook_received` to be staged and then rejected, which the harness reaches only
in a run's terminal moments. Reach for a unit test in
`packages/world-local/src/storage/` when a suspected filesystem race can be
staged directly. It costs milliseconds and does not depend on the interleaving
showing up.

In CI the same harness runs from `.github/workflows/event-log-race-repro.yml`,
triggered by adding the `event-log-race-repro` label to a PR or by
`workflow_dispatch`, whose inputs are the soak dial. Raise `timeout-minutes` in
that dispatch's branch if you raise `budget_ms`. Alongside the Vercel lane, the
workflow runs the local script against world-local and world-postgres as
parallel lanes. Those two lanes are report-only because the local storms have red
baselines at the default scale (see above), so they publish numbers rather than a
verdict and fail only when the harness produced no result file at all; the Vercel
lane remains the gate.

All three lanes land in one sticky PR comment, rendered from their artifacts by
the `event-log-race-repro-comment` job: a verdict line per lane, then a history
table of one row per lane per run (total / complete / corrupt / stuck / other),
then the latest run's non-completed runs with links. Each lane's own job summary
carries the same tables for that lane alone. The comment keeps the last few runs;
older ones stay in the jobs' artifacts, which hold the full results JSON.

To poke at a run afterwards, the CLI reads the same world from the environment:

```bash
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://world:world@localhost:5432/world \
  pnpm wf inspect <run-id>

WORKFLOW_TARGET_WORLD=local \
WORKFLOW_LOCAL_DATA_DIR=workbench/nextjs-turbopack/.next/workflow-data \
  pnpm wf inspect <run-id>
```

### Example app development

```bash
# Build workflow bundles for example app
cd workbench/example && pnpm build

# Use workflow CLI directly
cd workbench/example && pnpm workflow [command]
cd workbench/example && pnpm wf [command]  # shorthand
```

### Next.js app development

```bash
# Start Next.js dev server with workflow support
cd workbench/nextjs-turbopack && pnpm dev

# Build Next.js app with workflows
cd workbench/nextjs-turbopack && pnpm build

# Production server
cd workbench/nextjs-turbopack && pnpm start
```

## Key workflow concepts

**These are only relevant when writing code using the Workflow SDK**

- Workflow functions orchestrate step execution but have limited runtime access
- Step functions handle side effects, API calls, and complex logic with full Node.js access
- All function inputs/outputs are serialized to the event log for replay
- Built-in retry semantics for step functions with `FatalError`/`RetryableError` controls
- Standard JavaScript async patterns work: `Promise.all()`, `Promise.race()`, etc.

## File structure conventions

**These are only relevant when writing code using the Workflow SDK**

- Workflow files go in `workflows/` directory (or `src/workflows/` if using src)
- Generated API routes appear in `app/.well-known/workflow/v1/` (Next.js integration)
- Workflow files must contain `"use workflow"` or `"use step"` directives to be processed
- Add `.swc` directory to `.gitignore` for SWC plugin cache artifacts

## Package manager

This project uses pnpm with workspace configuration. The required version is specified in `package.json#packageManager`.

## Code style

- Uses Biome for formatting and linting
- 2-space indentation, single quotes, trailing commas (ES5)
- Import type enforcement enabled
- Explicit `any` is discouraged (Biome's `noExplicitAny` rule is currently disabled); exhaustive dependencies warnings enabled

## Local checks vs. CI

Linting, formatting, and typechecking (`pnpm lint`, `pnpm format`, `pnpm typecheck`) are all facets of the same static-quality gate, and CI runs them on every PR. Treat them as **advisory** while working locally: run them and fix obvious issues when it's convenient, but a failure in any of them should **not** block you from committing, pushing, or opening a PR. CI is the source of truth and will report anything that matters. Don't get stuck iterating locally to make these pass before handing off.

## Documentation standards

- README.md files in each package must accurately reflect the current functionality and purpose of that package
- READMEs should not contain outdated or incorrect information about package capabilities
- When modifying package functionality, ensure corresponding README updates are included
- Document every user-configurable environment variable in the docs.
- When modifying skill files in `skills/`, always bump the `version` field in the frontmatter metadata

### Docs preview links in PR descriptions

When a PR adds or updates docs pages (anything under `docs/content/`), add a "Docs Preview" section to the PR description with direct links to each changed page on the `workflow-docs` preview deployment:

- Get the preview base URL from the `vercel[bot]` comment on the PR. Use the Preview link from the `workflow-docs` project row (e.g. `https://workflow-docs-git-<branch-slug>.vercel.sh`). Don't construct the URL by hand because Vercel's branch-slug normalization is not a direct substitution.
- Map content paths to routes: `docs/content/docs/v5/<path>.mdx` is served at `/docs/<path>` (v5 is the default/latest version) and `docs/content/docs/v4/<path>.mdx` at `/v4/docs/<path>` (v4 is the maintenance version).
- When a change is scoped to a specific section of a page, link to its heading anchor (e.g. `/docs/foundations/hooks#checking-for-token-conflicts`) and verify the anchor matches a real heading in the MDX.
- A table with one row per page (and one column per docs version, when both v4 and v5 were updated) works well.
- The preview deployment sits behind deployment protection, so the links require Vercel team access. This is expected; include them anyway for reviewers.

## SWC plugin

When modifying the SWC compiler plugin (`packages/swc-plugin-workflow`), you must also update the specification document at `packages/swc-plugin-workflow/spec.md` to reflect any changes to the transformation behavior.

## Versioning & release strategy

This repository uses a dual-branch release model with [changesets](https://github.com/changesets/changesets) for version management.

### Branch model

- **`main`**: Bleeding-edge / beta channel. Changesets are in pre-release mode (`beta` tag). Published packages get the `beta` npm dist-tag (e.g. `5.0.0-beta.3`).
- **`stable`**: GA / production channel. Changesets are in regular mode. Published packages get the `latest` npm dist-tag (e.g. `4.2.1`).

Both branches trigger the release workflow (`.github/workflows/release.yml`) on push. The changesets action creates a "Version Packages" PR on each branch when there are pending changesets.

**Important:** Some directories are not fully maintained on the `stable` branch:

- **`docs/`**: Only `docs/content/` is actively maintained on `stable`; the rest of the docs app is a minimal placeholder (documentation is deployed only from `main`). `docs/content/` is kept on `stable` because the markdown files are bundled into npm packages via `prepack` scripts.
- **`skills/`**: Not maintained on `stable` at all. Skill files are unrelated to npm packaging, so there is no reason to keep them in sync on the release branch.

When backporting changes to `stable`, any conflicts involving docs app files (outside of `docs/content/`) or `skills/` files should be resolved by keeping the `stable` branch version (discarding the incoming change from `main`). Conflicts in `docs/content/` should be resolved normally. The backport GitHub Action handles this automatically.

#### The `changeset-release/main` branch is never deployed

Every Vercel project rooted in this repo sets `git.deploymentEnabled` to `false` for `changeset-release/main` in its `vercel.json`. **When you add a new Vercel project, add that key to its `vercel.json` too.**

The changesets action force-pushes `changeset-release/main`, and it can point at exactly main's HEAD SHA. Vercel keeps one commit status per project per SHA, so a preview deployment of that branch overwrites the production deployment's status for the same commit. `vercel/wait-for-deployment-action`, which reads the deployment ID out of that status, then hands a production e2e run a preview deployment ID, forking the run across environments.

Because those PRs have no deployment of their own, CI treats them specially: the Vercel e2e lanes in `tests.yml` run `vercel/wait-for-deployment-action` a second way, with `environment: production` and `sha` pinned to the PR's base SHA. They therefore test main's production deployment and run as `production`. (The commit-status ID that action reads is unambiguous for main SHAs precisely because this repo no longer deploys `changeset-release/main`, the only branch that ever deployed a commit main also deployed.) The deployment-dependent jobs in `docs-checks.yml`, `tarballs-checks.yml`, and `benchmarks.yml` are skipped. Anything new that waits on a deployment needs the same treatment.

### Changesets

- `workflow` and `@workflow/core` use changesets' "fixed" versioning strategy, so they always have the same version number
- Every PR requires a changeset to be included before it will be merged
- To check if one is needed, run `pnpm changeset status --since=main >/dev/null 2>&1 && echo "no changeset needed" || echo "changeset needed"`
- Create a changeset using `pnpm changeset add`
  - All changed packages should be included in the changeset. Never include unchanged packages.
  - Use the correct semver bump type: `patch` for bug fixes, `minor` for new features, `major` for breaking changes
  - On `main` (pre-release mode), the bump type doesn't affect beta numbering (it always increments `beta.N`) but it **does matter** when changes are backported to `stable`
- Remember to always build any packages that get changed before running downstream tests like e2e tests in the workbench
- Remember that changes made to one workbench should propagate to all other workbenches. The workflows should typically only be written once inside the example workbench and symlinked into all the other workbenches
- When writing changesets (via `pnpm changeset add` from the repo root, as noted above), keep the description terse: one sentence, or two at most. Try to make changesets that are specific to each modified package so they are targeted.

### Backporting to `stable`

Backports are handled by a GitHub Action (`.github/workflows/backport.yml`) that runs on every push to `main`. For each commit, AI analyzes the change and decides whether to recommend a backport. The action **always opens a PR** against `stable` for human review; it never pushes directly. The changeset file is included in the cherry-pick, so the correct semver bump type is preserved on `stable`.

**Decision criteria.** `stable` is a maintenance branch and takes **stability fixes only**. Feature work stays on `main`, however small or cleanly it would cherry-pick. AI is instructed to recommend a backport only for:

- Bug fixes to functionality that already exists on `stable`
- Correctness, data-loss, crash, hang, deadlock, and resource-leak fixes
- Security fixes, including dependency bumps that address a known vulnerability
- Fixes for regressions introduced by an earlier backport
- Test-only changes covering behavior that also exists on `stable`, and flaky-test fixes
- Build/CI/release-plumbing fixes needed to keep `stable` buildable and releasable
- Documentation corrections for content already on `stable` (fixing what's wrong, not documenting new capabilities)

AI is told to recommend AGAINST backporting anything else: new features and feature enhancements (including small, self-contained, additive ones), performance work and refactors that aren't fixing a user-visible defect, non-defect behavior changes to existing APIs, changes that build on `main`-only APIs, breaking changes for the next major, routine non-security dependency bumps, changes confined to directories not maintained on `stable` (the `docs/` app outside `docs/content/`, and `skills/`), and release plumbing like changeset/version-bump commits. Commits mixing a fix with feature work are declined, with the fix identified in the reasoning so a human can split it out.

When in doubt, AI is told to decline: a missed fix can be forced through later via `workflow_dispatch`, while unwanted change on `stable` costs its users the stability they stayed behind for.

**Manual override.** The workflow can be run manually from the GitHub Actions UI via `workflow_dispatch`, which accepts an optional `ref` input (a commit SHA on `main`; defaults to `main` HEAD) and an optional `model` input (the AI model used for AI-assisted decisions and conflict resolution, in `<provider>/<model>` form; defaults to the workflow's current default). Manual dispatch always forces a backport (skipping AI analysis). Use this when AI declined a backport that you want to ship to `stable`.

**No-backport notification.** When AI decides against a backport, it leaves a comment on the source PR (if one is associated with the commit) explaining its reasoning, with instructions for forcing a backport via `workflow_dispatch`.

**Conflict handling.** If the cherry-pick fails due to conflicts, the action first auto-resolves conflicts in directories that are not maintained on `stable` (docs app files under `docs/` except `docs/content/`, and any files under `skills/`) by keeping the `stable` branch version. It also auto-resolves `pnpm-lock.yaml` conflicts by re-running `pnpm install`. Any remaining conflicts are resolved using [opencode](https://opencode.ai) (AI-powered conflict resolution); the resulting backport PR notes that conflicts were AI-resolved and must be reviewed carefully. If AI cannot resolve the conflicts, the action comments on the original PR with instructions for manual resolution.

### Pre-release lifecycle

The `main` branch uses changesets' [pre-release mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) to publish beta versions.

**Starting a new pre-release cycle:**
1. Create a changeset with the desired base bump (e.g. `major` for a new major version)
2. Enter pre-release mode: `pnpm changeset pre enter beta`
3. Merge the "Version Packages (beta)" PR to publish the first beta

**Publishing subsequent betas:**
- Merge PRs with changesets to `main` as normal
- Each "Version Packages (beta)" PR merge publishes the next `beta.N` increment

**Graduating to stable:**
1. (Optional) Transition to release candidates: `pnpm changeset pre enter rc` (publishes `X.Y.Z-rc.N`)
2. Exit pre-release mode: `pnpm changeset pre exit`
3. The next "Version Packages" PR will publish the final stable version to npm

## Common patterns

### Build-time version injection
Use `genversion` to access package version at runtime. See `@workflow/core` and `@workflow/world-vercel` for examples:
- Add `genversion` as devDependency
- Update build script: `genversion --es6 src/version.ts && tsc`
- Add `src/version.ts` to `.gitignore` and `turbo.json` outputs

### Turbo caching for generated files
When a build step generates files, add them to the package's `turbo.json` outputs array to ensure proper caching.

## Architecture notes

### executionContext field
The `executionContext` field on workflow runs is a flexible JSONB/CBOR object that can store arbitrary data without schema changes. It flows through all worlds (local, postgres, vercel).

### Observability data hydration
`packages/core/src/observability.ts` contains `hydrateResourceIO` which strips certain fields (like `executionContext`) before UI display. If you need to display data from stripped fields, extract it before the stripping occurs.

### World packages must not hold mutable module state

`@workflow/world-local` and `@workflow/world-vercel` are bundled into the host
application's server build (see `VERCEL_WORLD_DEPENDENCY_PACKAGES` in
`packages/next/src/index.ts`). Bundlers key module identity on
`(resource, layer)`, and Next.js alone compiles `instrument`, app-route, `ssr`
and `edge` as separate module graphs, so one process holds one copy of every
module in these packages **per bundler layer**. A top-level `let`, or a `const`
holding a `Map`, is per-copy state, not the process singleton it reads as. A
duplicated mutex stops mutually excluding; a duplicated registry is a
deterministic miss; duplicated ID generators can fork a sequence.

Hold such state on the World instance where it is per-World, or on `globalThis`
via `globalSingleton()` from `@workflow/utils` where it is genuinely
process-wide. State that is deliberately per-copy needs a
`// per-copy-ok: <why>` annotation. `scripts/lint/module-scope-state.mjs`
enforces this across every published `packages/world-*`, run from
`@workflow/utils`'s test suite (with a local mirror in each world package), so
adding a new world package is covered automatically.

Custom worlds loaded through `WORKFLOW_TARGET_WORLD` are deduped by Node's
module cache and are safe today, but that is a property of how they are loaded,
not of how they are written, and it changed for world-vercel in #3493. Keep them
clean too. The author-facing version of this rule is in
`docs/content/worlds/{v4,v5}/building-a-world.mdx`; keep both versions in sync.

The sweep covers every package that ends up inside the host application's
server build: all published `packages/world-*` (discovered at runtime, so a new
world is covered the day it is added) plus `core`, `world`, `ai` and `nest`,
which are named in `BUNDLED_RUNTIME_PACKAGES` in
`packages/utils/src/module-scope-state.test.ts`. Adding a package that runs in
the host server means adding it to that list: "does this run inside the host's
server bundle" is a judgement, not something to infer from a directory name.

Deliberately outside the sweep, because a single module graph makes the hazard
impossible: `next`, `builders` and `sveltekit` (build-time code), `cli` (its own
process), `web` and `web-shared` (the observability UI), `vitest` (the test
runner's process), and private packages such as `world-sim`.

### Trace context propagation (world-vercel HTTP requests)
Every outgoing HTTP request from `@workflow/world-vercel` to workflow-server (or the queue) MUST explicitly inject W3C trace context so the server can parent its spans to the caller and traces stay correlated end to end. Call `injectTraceContextIntoHeaders(headers)` (from `packages/world-vercel/src/telemetry.ts`) on the outgoing headers, inside the client span when one exists. `makeRequest` in `utils.ts` is the reference implementation. It is a no-op when no OpenTelemetry SDK is registered.

Do **not** rely on ambient OpenTelemetry auto-instrumentation to do this: world-vercel's request paths use custom undici dispatchers / `global fetch`, which auto-instrumentation does not reliably hook. When you add a new request path or API version (e.g. a future v5 events API), wire the injection in the same place you build the request headers. The v4 events path (`fetchV4` in `events-v4.ts`) regressed cross-service correlation precisely by routing around `makeRequest` and skipping this step. Workflow-server spans stopped joining the flow-route invocation trace until the injection was added back. Cover new paths with a test in `trace-propagation.test.ts`.

The same rule covers a request path that is not an HTTP request. A non-`fetch` transport must still open the client span callers read a trace through: use `withHttpClientSpan` (`http-core.ts`), the envelope `instrumentedFetch` is built on, so the span carries the same name, kind, and attributes rather than a hand-rolled parallel shape. The WS events transport is the worked example. `postEventFrameOverWs` synthesizes an `http POST` span per frame and tags it `workflow.events.transport: 'ws'`, and the handshake gets its own `workflow.events.ws.connect` span (`ws-transport-spans.test.ts`). Adding a transport that writes events without one silently deletes the per-event view of a run.
