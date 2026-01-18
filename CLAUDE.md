# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Workflow DevKit is a durable functions framework for JavaScript/TypeScript that enables writing long-running, stateful application logic on top of stateless compute. The runtime persists progress as an event log and deterministically replays code to reconstruct state after cold starts, failures, or scale events.

This repository contains the client side SDK code for workflows, along example apps that showcase Workflow DevKit in action.

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

# Lint and typecheck with Biome
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

**These are only relevant when writing code using the Workflow DevKit**

- Workflow functions orchestrate step execution but have limited runtime access
- Step functions handle side effects, API calls, and complex logic with full Node.js access
- All function inputs/outputs are serialized to the event log for replay
- Built-in retry semantics for step functions with `FatalError`/`RetryableError` controls
- Standard JavaScript async patterns work: `Promise.all()`, `Promise.race()`, etc.

## File Structure Conventions

**These are only relevant when writing code using the Workflow DevKit**

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
- No explicit any allowed, exhaustive dependencies warnings enabled

## Documentation Standards

- README.md files in each package must accurately reflect the current functionality and purpose of that package
- READMEs should not contain outdated or incorrect information about package capabilities
- When modifying package functionality, ensure corresponding README updates are included

## Changesets

- Every PR requires a changeset to be included before it will be merged
- To check if one is needed, run `pnpm changeset status --since=main >/dev/null 2>&1 && echo "no changeset needed" || echo "changeset needed"`
- Create a changeset using `pnpm changeset add`
  - All changed packages should be included in the changeset. Never include unchanged packages.
  - All changes should be marked as "patch". Never use "major" or "minor" modes.
- Remember to always build any packages that get changed before running downstream tests like e2e tests in the workbench
- Remember that changes made to one workbench should propagate to all other workbenches. The workflows should typically only be written once inside the example workbench and symlinked into all the other workbenches
- When writing changesets, use the `pnpm changeset` command from the root of the repo. Keep the changesets terse (see existing changesets for examples). Try to make changesets that are specific to each modified package so they are targeted. Ensure that any breaking changes are marked as "**BREAKING CHANGE**"

# AGENTS.md

@AGENTS.md
