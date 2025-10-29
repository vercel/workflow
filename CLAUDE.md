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
- **packages/world-embedded**: Filesystem-based workflow backend for local development and testing (`@workflow/world-local`)
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

# Run E2E tests
cd packages/core && pnpm test:e2e
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
