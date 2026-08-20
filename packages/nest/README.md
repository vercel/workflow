# @workflow/nest

NestJS integration for Workflow SDK.

## Installation

```bash
npm install @workflow/nest
# or
pnpm add @workflow/nest
```

You also need to install the SWC packages required by NestJS's SWC builder:

```bash
npm install -D @swc/cli @swc/core
# or
pnpm add -D @swc/cli @swc/core
```

## Quick Start

### 1. Initialize SWC Configuration

After installing the package, run the init command to generate the SWC configuration:

```bash
npx @workflow/nest init
```

This creates a `.swcrc` file configured with the Workflow SWC plugin for client-mode transformations.

`init` writes only the settings the workflow transform needs (the plugin entry, decorator parsing and metadata, and `module.type`). Any other SWC configuration already in the file is preserved, and `--force` refreshes the resolved plugin path rather than replacing the file.

**Important:** Add `.swcrc` to your `.gitignore` as it contains machine-specific absolute paths:

```bash
echo '/.swcrc' >> .gitignore
```

### 2. Configure NestJS to use SWC

Ensure your `nest-cli.json` has SWC as the builder:

{/*@skip-typecheck: Shows nest-cli.json configuration*/}

```json
{
  "compilerOptions": {
    "builder": "swc"
  }
}
```

### 3. Import the WorkflowModule

In your `app.module.ts`:

{/*@skip-typecheck: Shows WorkflowModule import*/}

```typescript
import { Module } from '@nestjs/common';
import { WorkflowModule } from '@workflow/nest';

@Module({
  imports: [WorkflowModule.forRoot()],
})
export class AppModule {}
```

### 4. Create Workflow Files

Create workflow files in your `src/` directory with `"use workflow"` and `"use step"` directives:

{/*@skip-typecheck: Shows workflow file*/}

```typescript
// src/workflows/example.ts
export async function myStep(data: string) {
  'use step';
  return data.toUpperCase();
}

export async function myWorkflow(input: string) {
  'use workflow';
  const result = await myStep(input);
  return result;
}
```

### 5. Add Pre-build Scripts

Add scripts to regenerate configuration before builds:

```json
{
  "scripts": {
    "prebuild": "npx @workflow/nest init --force",
    "build": "nest build"
  }
}
```

## Configuration Options

{/*@skip-typecheck: Shows WorkflowModule.forRoot options*/}

```typescript
WorkflowModule.forRoot({
  // Directory to scan for workflow files (default: ['src'])
  dirs: ['src'],

  // Output directory for generated bundles (default: '.nestjs/workflow')
  outDir: '.nestjs/workflow',

  // Skip building bundles on startup. Defaults to true when VERCEL is set.
  // With this on and no bundles present, startup fails with an explicit error.
  skipBuild: false,

  // Route prefix the workflow endpoints are served under. Leave unset to adopt
  // app.setGlobalPrefix() automatically; set it for a reverse-proxy sub-path.
  basePath: '/api',

  // Start the target World's background workers with the app and close them on
  // shutdown. Needed for self-hosted Worlds; leave off on Vercel.
  manageWorldLifecycle: false,

  // Load the generated bundles at startup instead of on the first request.
  preloadBundles: true,

  // SWC module type: 'es6' (default) or 'commonjs'
  // Set to 'commonjs' if your NestJS project compiles to CJS via SWC
  moduleType: 'es6',

  // Directory where NestJS compiles .ts to .js (default: 'dist')
  // Only used when moduleType is 'commonjs'
  // Should match the outDir in your tsconfig.json
  distDir: 'dist',
});
```

Options can come from other providers with `forRootAsync`:

{/*@skip-typecheck: Shows WorkflowModule.forRootAsync options*/}

```typescript
WorkflowModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    basePath: config.get('API_PREFIX'),
  }),
});
```

### Raw request bodies

Create the app with `rawBody` so a signed webhook body reaches the workflow
byte-for-byte:

{/*@skip-typecheck: Shows the NestFactory.create option*/}

```typescript
const app = await NestFactory.create(AppModule, { rawBody: true });
```

Without it the parsed body has to be re-serialized, which changes whitespace and
key order and breaks signature verification. A warning is logged once when that
fallback is used.

### Dependency injection is not available in workflows and steps

Workflows and steps are compiled into separate bundles and do not run inside the
NestJS application, so the injector, your providers, request-scoped context,
guards, interceptors and the Nest `Logger` are all out of reach from
`"use workflow"` and `"use step"` code. A class imported into a step is a
different class object from the one your module registered, so `app.get()` on it
raises `UnknownElementException`; on Vercel the workflow function is a separate
function from the app entirely. Write steps as plain functions over their
arguments and keep DI in your controllers and providers.

## Deploying to Vercel

NestJS is not a Vercel-native framework, so the Workflow SDK emits a
[Vercel Build Output API](https://vercel.com/docs/build-output-api/v3) directory
(`.vercel/output`) for it. This includes the combined workflow queue-consumer
function (registered with `experimentalTriggers` so Vercel Queue dispatches your
runs) alongside your NestJS app bundled as a catch-all function. Without it,
deployed workflow runs stay `pending` because nothing consumes the queue.

### 1. Add a serverless entry module

Create a `_vercel/entry.ts` that default-exports a Node request handler backed by
your NestJS app (the `_vercel/` prefix avoids colliding with Vercel's automatic
`api/` function detection). Import `AppModule` from the **compiled** `dist/`
output — `nest build` runs first and its SWC pass emits the decorator metadata
NestJS DI relies on; importing raw `src/` TypeScript would route the app back
through esbuild, which does not emit `emitDecoratorMetadata`. Also import
`reflect-metadata` at the top so DI metadata is registered:

{/*@skip-typecheck: Shows the Vercel entry module shape*/}

```typescript
// _vercel/entry.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
// Compiled by `nest build` before the Vercel Build Output step runs.
import { AppModule } from '../dist/app.module.js';

let ready: Promise<any> | undefined;

async function createHandler() {
  const app = await NestFactory.create(AppModule);
  await app.init();
  return app.getHttpAdapter().getInstance(); // the Express instance
}

export default async function handler(req: any, res: any) {
  ready ??= createHandler();
  const instance = await ready;
  return instance(req, res);
}
```

### 2. Skip the in-process build on Vercel

The Vercel Build Output already contains the compiled workflow bundles, so tell
`WorkflowModule` not to rebuild them at runtime:

{/*@skip-typecheck: Shows WorkflowModule.forRoot on Vercel*/}

```typescript
WorkflowModule.forRoot({ skipBuild: Boolean(process.env.VERCEL) })
```

### 3. Wire up the build command

Add a `vercel-build` script that compiles the app and then emits the Build
Output. `workflow-nest build` emits the Vercel Build Output automatically when
the `VERCEL` env var is set (pass `--vercel` to force it locally):

```json
{
  "scripts": {
    "vercel-build": "nest build && npx @workflow/nest build"
  }
}
```

`nest build` (via SWC) compiles your app — including the decorator metadata and
the workflow client transform — and `@workflow/nest build` bundles the app plus
the workflow functions into `.vercel/output`.

> **Note:** Native addons (`*.node`) are not bundled or traced into the deployed
> function, so NestJS apps that depend on native modules are not yet supported by
> `--vercel`.

## How It Works

The `@workflow/nest` package provides:

1. **WorkflowModule** - A NestJS module that handles workflow bundle building and HTTP routing
2. **WorkflowController** - Handles workflow and step execution requests at `.well-known/workflow/v1/`
3. **NestLocalBuilder** - Builds workflow bundles (steps.mjs, workflows.mjs) from your source files. Exposed at the `@workflow/nest/builder` subpath (not the package root — the root entry stays free of build-time dependencies so importing `WorkflowModule` never drags the compiler into your runtime bundle).
4. **NestVercelBuilder** - Emits a Vercel Build Output API directory for deploying on Vercel. Exposed at the `@workflow/nest/vercel-builder` subpath.
5. **CLI** - Generates `.swcrc` configuration with the SWC plugin properly resolved, and builds workflow bundles / the Vercel Build Output

## Why the CLI?

NestJS uses its own SWC builder that reads configuration from `.swcrc`. The Workflow SWC plugin needs to be referenced by path in this file. The CLI resolves the plugin path from `@workflow/nest`'s dependencies, eliminating the need for manual configuration or pnpm hoisting.

### Technical Details

When you run `npx @workflow/nest init`, it:

1. Resolves the path to `@workflow/swc-plugin` (bundled as a dependency of `@workflow/nest`)
2. Generates `.swcrc` with the absolute path to the plugin
3. Configures client-mode transformation for workflow files

This approach ensures:

- No manual SWC plugin configuration required
- No pnpm hoisting configuration required in `.npmrc`
- The plugin is always resolved from the correct location

### Why Workflows Must Be in `src/`

NestJS's SWC builder only compiles files within the `sourceRoot` directory (typically `src/`). For the workflow client-mode transform to work, workflow files must be in `src/` so they get compiled with the SWC plugin that attaches `workflowId` properties needed by `start()`.

## API Reference

### WorkflowModule

{/*@skip-typecheck: Shows WorkflowModule usage*/}

```typescript
import { WorkflowModule } from '@workflow/nest';

// Basic usage
WorkflowModule.forRoot()

// With options
WorkflowModule.forRoot({
  dirs: ['src/workflows'],
  outDir: '.nestjs/workflow',
  skipBuild: process.env.NODE_ENV === 'production',
  moduleType: 'commonjs',  // if using SWC CommonJS compilation
  distDir: 'dist',          // where compiled .js files live
})
```

### CLI Commands

```bash
# Generate .swcrc configuration
npx @workflow/nest init

# Force regenerate (overwrites existing)
npx @workflow/nest init --force

# Build workflow bundles for local dev
npx @workflow/nest build

# Emit the Vercel Build Output (.vercel/output); implied when VERCEL is set
npx @workflow/nest build --vercel

# Show help
npx @workflow/nest --help
```

#### `build` options

| Flag | Description | Default |
| --- | --- | --- |
| `--vercel` | Emit a Vercel Build Output API directory (`.vercel/output`) with the workflow queue-consumer function. Implied when the `VERCEL` env var is set. | off (on under `VERCEL`) |
| `--dirs <dirs>` | Comma-separated workflow source directories to scan. | `src` |
| `--entry <path>` | Vercel app entry module that default-exports a Node request handler. | auto-detected (e.g. `_vercel/entry.js`) |
| `--out-dir <dir>` | Output directory for local-dev bundles (ignored with `--vercel`). | `.nestjs/workflow` |
| `--module <type>` | SWC module type: `es6` or `commonjs`. | `es6` |
| `--base-path <path>` | Route prefix the app is served under. Must match `setGlobalPrefix()` / `basePath`. | none |
| `--sourcemap <mode>` | esbuild sourcemap mode: `true`, `false`, `inline`, `linked`, `external`, `both`. | builder default |
| `--max-duration <secs>` | `maxDuration` for the app function. | `300` |
| `--runtime <runtime>` | Vercel runtime for the emitted functions, e.g. `nodejs22.x`. | platform default |
| `--app-function <name>` | Name of the catch-all app function. | `__nest` |

## License

Apache-2.0
