# Agent Instructions

**CRITICAL RULES:**
- NEVER push directly to the `main` or `stable` branches
- Do not remove or break agent-discoverable docs sitemap behavior: keep docs/app/sitemap.md/route.ts and docs/app/[lang]/sitemap.md/route.ts, and keep the sitemap link in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts.

## Overview

Workflow SDK is a durable functions framework for JavaScript/TypeScript that enables writing long-running, stateful application logic on top of stateless compute. The runtime persists progress as an event log and deterministically replays code to reconstruct state after cold starts, failures, or scale events.

This repository contains the client-side SDK code for workflows, along with example apps that showcase Workflow SDK in action.

## Architecture

### Core Components

- **packages/core**: Core workflow runtime and primitives (`@workflow/core`)
- **packages/next**: Next.js integration (`@workflow/next`)
- **packages/cli**: Command-line interface (`@workflow/cli`)
- **packages/world**: Core interfaces and types for workflow storage backends (`@workflow/world`)
- **packages/world-local**: Filesystem-based workflow backend for local development and testing (`@workflow/world-local`)
- **packages/world-vercel**: Production workflow backend for Vercel platform deployments (`@workflow/world-vercel`)
- **packages/swc-plugin-workflow**: SWC compiler plugin for workflow transformations
- **workbench/example**: Basic workflow examples using the CLI (aka "standalone mode")
- **workbench/nextjs-turbopack**: Workflow examples using the Next.js integration

### Workflow Execution Model

Workflows consist of two types of functions:

1. **Workflow functions** (`"use workflow"`): Orchestrators that run in a sandboxed VM without full Node.js access
2. **Step functions** (`"use step"`): Individual pieces of logic with full Node.js runtime access

The framework uses compiler transformations to split workflow files into separate bundles for client, workflow, and step execution contexts.

## Development Commands

### Workspace-level Commands

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

### Core Package Testing

```bash
# Test core functionality
cd packages/core && pnpm test

# Test specific file
cd packages/core && pnpm vitest run src/[filename].test.ts

# Run E2E tests (requires environment variables and running dev server)
# Note: Use nextjs-turbopack for local e2e testing (not example app - it has no dev server)

# Step 1: Start the dev server in background
cd workbench/nextjs-turbopack && pnpm dev > /tmp/nextjs-dev.log 2>&1 &

# Step 2: Wait for server to be ready (usually 15-20 seconds)
sleep 15

# Step 3: Run the e2e tests from the project root
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts

# Step 4: Stop the dev server when done
pkill -f "pnpm dev"

# To run specific tests, use the -t flag:
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts -t "sleeping"

# For production testing against deployed Vercel app:
# See .github/workflows/tests.yml for required environment variables:
# - DEPLOYMENT_URL: URL of deployed app
# - APP_NAME: App name (example, nextjs-turbopack, nextjs-webpack, nitro)
# - WORKFLOW_VERCEL_ENV: Environment (production or preview)
# - WORKFLOW_VERCEL_AUTH_TOKEN: Vercel auth token
# - WORKFLOW_VERCEL_TEAM: Vercel team ID
# - WORKFLOW_VERCEL_PROJECT: Vercel project ID
```

### Example App Development

```bash
# Build workflow bundles for example app
cd workbench/example && pnpm build

# Use workflow CLI directly
cd workbench/example && pnpm workflow [command]
cd workbench/example && pnpm wf [command]  # shorthand
```

### Next.js App Development

```bash
# Start Next.js dev server with workflow support
cd workbench/nextjs-turbopack && pnpm dev

# Build Next.js app with workflows
cd workbench/nextjs-turbopack && pnpm build

# Production server
cd workbench/nextjs-turbopack && pnpm start
```

## Key Workflow Concepts

**These are only relevant when writing code using the Workflow SDK**

- Workflow functions orchestrate step execution but have limited runtime access
- Step functions handle side effects, API calls, and complex logic with full Node.js access
- All function inputs/outputs are serialized to the event log for replay
- Built-in retry semantics for step functions with `FatalError`/`RetryableError` controls
- Standard JavaScript async patterns work: `Promise.all()`, `Promise.race()`, etc.

## File Structure Conventions

**These are only relevant when writing code using the Workflow SDK**

- Workflow files go in `workflows/` directory (or `src/workflows/` if using src)
- Generated API routes appear in `app/.well-known/workflow/v1/` (Next.js integration)
- Workflow files must contain `"use workflow"` or `"use step"` directives to be processed
- Add `.swc` directory to `.gitignore` for SWC plugin cache artifacts

## Package Manager

This project uses pnpm with workspace configuration. The required version is specified in `package.json#packageManager`.

## Code Style

- Uses Biome for formatting and linting
- 2-space indentation, single quotes, trailing commas (ES5)
- Import type enforcement enabled
- Explicit `any` is discouraged (Biome's `noExplicitAny` rule is currently disabled); exhaustive dependencies warnings enabled

## Documentation Standards

- README.md files in each package must accurately reflect the current functionality and purpose of that package
- READMEs should not contain outdated or incorrect information about package capabilities
- When modifying package functionality, ensure corresponding README updates are included
- When modifying skill files in `skills/`, always bump the `version` field in the frontmatter metadata

## SWC Plugin

When modifying the SWC compiler plugin (`packages/swc-plugin-workflow`), you must also update the specification document at `packages/swc-plugin-workflow/spec.md` to reflect any changes to the transformation behavior.

## Versioning & Release Strategy

This repository uses a dual-branch release model with [changesets](https://github.com/changesets/changesets) for version management.

### Branch Model

- **`main`** — Bleeding-edge / beta channel. Changesets are in pre-release mode (`beta` tag). Published packages get the `beta` npm dist-tag (e.g. `5.0.0-beta.3`).
- **`stable`** — GA / production channel. Changesets are in regular mode. Published packages get the `latest` npm dist-tag (e.g. `4.2.1`).

Both branches trigger the release workflow (`.github/workflows/release.yml`) on push. The changesets action creates a "Version Packages" PR on each branch when there are pending changesets.

**Important:** On the `stable` branch, only `docs/content/` is actively maintained — the rest of the docs app is a minimal placeholder. Documentation is deployed only from `main`. The `docs/content/` directory is kept on `stable` because the markdown files are bundled into npm packages via `prepack` scripts. When backporting changes to `stable`, any conflicts involving docs app files (outside of `docs/content/`) should be resolved by keeping the `stable` branch version (discarding the incoming change from `main`). Conflicts in `docs/content/` should be resolved normally. The backport GitHub Action handles this automatically.

### Changesets

- `workflow` and `@workflow/core` use changesets' "fixed" versioning strategy — they always have the same version number
- Every PR requires a changeset to be included before it will be merged
- To check if one is needed, run `pnpm changeset status --since=main >/dev/null 2>&1 && echo "no changeset needed" || echo "changeset needed"`
- Create a changeset using `pnpm changeset add`
  - All changed packages should be included in the changeset. Never include unchanged packages.
  - Use the correct semver bump type: `patch` for bug fixes, `minor` for new features, `major` for breaking changes
  - On `main` (pre-release mode), the bump type doesn't affect beta numbering (it always increments `beta.N`) but it **does matter** when changes are backported to `stable`
- Remember to always build any packages that get changed before running downstream tests like e2e tests in the workbench
- Remember that changes made to one workbench should propagate to all other workbenches. The workflows should typically only be written once inside the example workbench and symlinked into all the other workbenches
- When writing changesets, use the `pnpm changeset` command from the root of the repo. Keep the changesets terse (see existing changesets for examples). Try to make changesets that are specific to each modified package so they are targeted. Ensure that any breaking changes are marked as "**BREAKING CHANGE**"

### Backporting to `stable`

To backport a change from `main` to `stable`, add the `backport-stable` label to the PR on `main`. A GitHub Action (`.github/workflows/backport.yml`) will automatically cherry-pick the squashed commit to `stable`. The label can be added before or after merging — the action triggers on both merge and label events. The changeset file is included in the cherry-pick, so the correct semver bump type is preserved on `stable`.

If the cherry-pick fails due to conflicts, the action first auto-resolves any docs app conflicts (files under `docs/` except `docs/content/`) by keeping the `stable` branch version, since the docs app is a minimal placeholder on `stable` and not actively maintained there. It also auto-resolves `pnpm-lock.yaml` conflicts by re-running `pnpm install`. If those resolve everything, the cherry-pick is pushed directly to `stable`. Otherwise, it attempts to resolve remaining conflicts using [opencode](https://opencode.ai) (AI-powered conflict resolution). If successful, it creates a PR targeting `stable` for human review instead of pushing directly. If the AI cannot resolve the conflicts, the action will comment on the original PR with instructions for manual resolution.

### Pre-release Lifecycle

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

## Common Patterns

### Build-time Version Injection
Use `genversion` to access package version at runtime. See `@workflow/core` and `@workflow/world-vercel` for examples:
- Add `genversion` as devDependency
- Update build script: `genversion --es6 src/version.ts && tsc`
- Add `src/version.ts` to `.gitignore` and `turbo.json` outputs

### Turbo Caching for Generated Files
When a build step generates files, add them to the package's `turbo.json` outputs array to ensure proper caching.

## Architecture Notes

### executionContext Field
The `executionContext` field on workflow runs is a flexible JSONB/CBOR object that can store arbitrary data without schema changes. It flows through all worlds (local, postgres, vercel).

### Observability Data Hydration
`packages/core/src/observability.ts` contains `hydrateResourceIO` which strips certain fields (like `executionContext`) before UI display. If you need to display data from stripped fields, extract it before the stripping occurs.
