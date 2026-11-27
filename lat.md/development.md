# Development

Workspace commands, workbench applications and build conventions guide development in this repository.

## Knowledge graph setup

The checked-in graph can be read and validated without configuring an agent integration. Lat 0.13.11 is the CLI version used to validate these instructions.

```sh
npm install --global lat.md@0.13.11
lat locate "Architecture"
lat section "architecture#Architecture"
lat check
```

For semantic search with the bundled local embedding backend, run `lat reindex --local`, then `lat search "trace context propagation"`. Local embeddings require no API key. Embedding preferences are machine-local; the Git checkout does not select a backend for every contributor.

Hosted embeddings are optional and require the configured provider's key. Use `lat reindex --remote` to switch deliberately. `lat locate`, `lat section` and `lat check` work without an embedding API key; consult `lat --help` and `lat reindex --help` for the installed version's options.

## Agent integration ownership

`lat init` selects personal coding-agent, MCP and hook integrations. It is optional for reading or checking this existing graph and can update generated integration files.

Lat manages only the `lat:begin` / `lat:end` block in [[AGENTS.md]] and the generated [[.agents/skills/lat-md/SKILL.md|authoring skill]]. Repository-specific instructions outside the block are maintained by contributors. [[CLAUDE.md]] points to the same root instructions. Keep generated templates intact; put project knowledge in this graph.

Run `lat init` when setting up integrations, selecting only the agents in use. Codex hooks and MCP configuration are personal setup; hooks require trust through `/hooks` before execution. The root ignore rules exclude local Codex integration and UI build output; [[lat.md/.gitignore]] excludes disposable graph caches and local source overrides.

## Knowledge ownership

Each topic has one detailed authority. Move knowledge to its owner and replace the old body with a link rather than maintaining parallel explanations.

- [[architecture]] owns the execution overview, package map and repository-wide runtime invariants.
- [[testing]], [[event-log-race-repro]] and [[bundle-size]] own validation procedures and result interpretation.
- [[documentation]], [[pull-requests]] and [[releases]] own contributor procedures for their respective tasks.
- Package READMEs own package purpose, supported interfaces and user setup. Runtime design notes remain beside their code; [[architecture#Architecture#Workflow execution model]] indexes the relevant notes.
- [[AGENTS.md]] owns immediate constraints and required reading, not copies of the detailed knowledge.

The authoring skill owns Lat syntax and graph validation rules. Follow it when editing graph content, keep directory indexes accurate, and run `lat check` after graph changes. Repository-path links to other Markdown validate file existence but do not import that document into Lat search.

## Package manager

This project uses pnpm with workspace configuration. The required version is specified in `package.json#packageManager`.

## Workspace-level commands

Run workspace builds, tests and static checks with pnpm.

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

## Example app development

Build workflow bundles and use the CLI in the example workbench.

```bash
# Build workflow bundles for example app
cd workbench/example && pnpm build

# Use workflow CLI directly
cd workbench/example && pnpm workflow [command]
cd workbench/example && pnpm wf [command]  # shorthand
```

## Next.js app development

Use the Turbopack workbench to run a Next.js application with workflows.

```bash
# Start Next.js dev server with workflow support
cd workbench/nextjs-turbopack && pnpm dev

# Build Next.js app with workflows
cd workbench/nextjs-turbopack && pnpm build

# Production server
cd workbench/nextjs-turbopack && pnpm start
```

## Code style

Source formatting and imports follow Biome and EditorConfig conventions.

- Uses Biome for formatting and linting
- 2-space indentation, single quotes, trailing commas (ES5)
- Import type enforcement enabled
- Explicit `any` is discouraged (Biome's `noExplicitAny` rule is currently disabled); exhaustive dependencies warnings enabled
- Observability UI ([[packages/web|`packages/web`]], [[packages/web-shared|`packages/web-shared`]]): never use opacity to set a text colour. Read [[packages/web-shared/AGENTS.md|`packages/web-shared/AGENTS.md`]] before touching styles there.

## Local checks vs. CI

Linting, formatting, and typechecking (`pnpm lint`, `pnpm format`, `pnpm typecheck`) are all facets of the same static-quality gate, and CI runs them on every PR.

Treat them as **advisory** while working locally: run them and fix obvious issues when it's convenient, but a failure in any of them should **not** block you from committing, pushing, or opening a PR. CI is the source of truth and will report anything that matters. Don't get stuck iterating locally to make these pass before handing off.

## Common patterns

Build conventions cover runtime version injection and generated-file caching.

### Build-time version injection

Use `genversion` to access package version at runtime.

See `@workflow/core` and `@workflow/world-vercel` for examples:
- Add `genversion` as devDependency
- Update build script: `genversion --es6 src/version.ts && tsc`
- Add `src/version.ts` to `.gitignore` and `turbo.json` outputs

### Turbo caching for generated files

When a build step generates files, add them to the package's `turbo.json` outputs array to ensure proper caching.
