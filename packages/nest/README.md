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

<a id="quick-start"></a>

## Quick start

### 1. Initialize SWC configuration

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

```ts
import { Module } from '@nestjs/common';
import { WorkflowModule } from '@workflow/nest';

@Module({
  imports: [WorkflowModule.forRoot()],
})
export class AppModule {}
```

### 4. Create workflow files

Create workflow files in your `src/` directory with `"use workflow"` and `"use step"` directives:

{/*@skip-typecheck: Shows workflow file*/}

```ts
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

### 5. Add pre-build scripts

Add scripts to regenerate configuration before builds:

```json
{
  "scripts": {
    "prebuild": "npx @workflow/nest init --force",
    "build": "nest build"
  }
}
```

## Configuration options

{/*@skip-typecheck: Shows WorkflowModule.forRoot options*/}

```ts
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
  // Defaults to true, or false when VERCEL is set.
  preloadBundles: true,

  // Keep the application's body parser away from the workflow routes so queue
  // deliveries are not capped at Express's 100 KB limit and webhook bodies stay
  // byte-exact. Defaults to true. See "Request bodies" below.
  bypassBodyParser: true,

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

### Request bodies

The queue delivers run inputs, step inputs and step outputs in the HTTP body of
a `POST /.well-known/workflow/v1/flow`, so those bodies are as large as the data
your workflows pass around. Express caps request bodies at 100 KB, and NestJS
installs that parser by default, which would answer any larger delivery with
`413` before the request reached a controller.

`WorkflowModule` therefore makes the application's body parsers stand aside for
`.well-known/workflow/v1`, and nothing else. On Express, workflow requests are
read straight from the request stream, which also means a signed webhook body
arrives byte-for-byte without `{ rawBody: true }`. Fastify always parses the body
before the route runs, so create a Fastify app with `{ rawBody: true }` to keep
signed webhook bodies byte-exact. Your own routes keep the parsers, and the
limits, you configured. Set `bypassBodyParser: false` to turn this off.

A body that arrives with a `content-encoding` still goes through the parser,
because that is what inflates it.

#### Fastify

Fastify enforces its body limit before any content-type parser runs, and that
limit is per instance rather than per route, so it cannot be scoped to the
workflow routes. Raise it on the adapter instead; `WorkflowModule` logs a
warning at startup while it is still at Fastify's 1 MiB default:

{/*@skip-typecheck: Shows the FastifyAdapter option*/}

```typescript
const app = await NestFactory.create(
  AppModule,
  new FastifyAdapter({ bodyLimit: 16 * 1024 * 1024 })
);
```

Fastify also answers content types it has no parser for with `415` before the
request reaches a controller. If you receive webhooks as `application/octet-stream`
or another unparsed media type, register a catch-all parser:

{/*@skip-typecheck: Shows a Fastify content type parser*/}

```typescript
app
  .getHttpAdapter()
  .getInstance()
  .addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body)
  );
```

### Guards, interceptors and pipes

The workflow routes are served by a controller inside your application, so a
global guard runs for them too. A guard that rejects unauthenticated requests
rejects every queue delivery and webhook with `403`, and runs stop making
progress. Let them through with `isWorkflowRequest`:

{/*@skip-typecheck: Shows a guard that exempts the workflow routes*/}

```typescript
import { isWorkflowRequest } from '@workflow/nest';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (isWorkflowRequest(context)) return true;
    // ...your own checks
  }
}
```

These routes authenticate their own callers — queue deliveries are signed and
webhook tokens are single-use secrets — so exempting them exposes nothing.

Interceptors and exception filters are safe to leave in place: the handlers
write through `@Res()`, so the status and body the workflow runtime produced
reach the caller unchanged.

### Route versioning

`app.enableVersioning()` moves every route under a version segment, which would
put the workflow routes somewhere the SDK does not generate URLs for. The
controller is registered as `VERSION_NEUTRAL`, so it stays at
`.well-known/workflow/v1` whichever versioning strategy you enable. A global
prefix still applies, and is adopted automatically.

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
output. `nest build` runs first, and its SWC pass emits the decorator metadata
NestJS DI relies on; importing raw `src/` TypeScript would route the app back
through esbuild, which does not emit `emitDecoratorMetadata`. Also import
`reflect-metadata` at the top so DI metadata is registered:

{/*@skip-typecheck: Shows the Vercel entry module shape*/}

```ts
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

### 2. The in-process build is skipped for you

No module change is needed: `skipBuild` defaults to `true` when the `VERCEL`
environment variable is set, because the Build Output already contains the
compiled workflow bundles and the deployed filesystem is read-only.

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

`nest build` (via SWC) compiles your app, including the decorator metadata and
the workflow client transform. Then, `@workflow/nest build` bundles the app and
the workflow functions into `.vercel/output`.

### Dependencies the bundler cannot follow

The app function is bundled with esbuild. A package that resolves a dependency
at runtime behind a `try`/`catch` — a database driver reached through an ORM, an
optional logger transport — looks like a hard dependency to the bundler, which
fails the build on the first one your app has not installed. NestJS's own
optional peers (`class-validator`, `@nestjs/microservices`, and friends) are
handled for you. Pass anything else to `--external`:

```bash
npx @workflow/nest build --vercel --external oracledb,mysql2
```

Only list packages the deployed code path never loads: an externalized package
is left as a bare `require()` that has to resolve inside the function.

> **Note:** Native addons (`*.node`) are not bundled or traced into the deployed
> function, so NestJS apps that depend on native modules are not yet supported by
> `--vercel`. The build warns and names the addons it can see; one loaded through
> `bindings()` or `node-gyp-build` computes its path at runtime and is invisible
> to the bundler.

## How it works

The `@workflow/nest` package provides:

1. **WorkflowModule**: A NestJS module that handles workflow bundle building and HTTP routing
2. **WorkflowController**: Handles workflow and step execution requests at `.well-known/workflow/v1/`
3. **NestLocalBuilder**: Builds workflow bundles (`steps.mjs` and `workflows.mjs`) from your source files. Exposed at the `@workflow/nest/builder` subpath (not the package root, which stays free of build-time dependencies so importing `WorkflowModule` never adds the compiler to your runtime bundle).
4. **NestVercelBuilder**: Emits a Vercel Build Output API directory for deploying on Vercel. Exposed at the `@workflow/nest/vercel-builder` subpath.
5. **CLI**: Generates `.swcrc` configuration with the SWC plugin resolved and builds workflow bundles or the Vercel Build Output
6. **isWorkflowRequest()**: Recognises a workflow request from an `ExecutionContext`, so an application guard can let queue deliveries and webhooks through

Both NestJS platforms are supported: `@nestjs/platform-express` and
`@nestjs/platform-fastify`.

## Why the CLI?

NestJS uses its own SWC builder that reads configuration from `.swcrc`. The Workflow SWC plugin needs to be referenced by path in this file. The CLI resolves the plugin path from `@workflow/nest`'s dependencies, eliminating the need for manual configuration or pnpm hoisting.

### Technical details

When you run `npx @workflow/nest init`, it:

1. Resolves the path to `@workflow/swc-plugin` (bundled as a dependency of `@workflow/nest`)
2. Generates `.swcrc` with the absolute path to the plugin
3. Configures client-mode transformation for workflow files

This approach ensures:

- No manual SWC plugin configuration required
- No pnpm hoisting configuration required in `.npmrc`
- The plugin is always resolved from the correct location

### Why workflows must be in `src/`

NestJS's SWC builder only compiles files within the `sourceRoot` directory (typically `src/`). For the workflow client-mode transform to work, workflow files must be in `src/` so they get compiled with the SWC plugin that attaches `workflowId` properties needed by `start()`.

## API reference

### WorkflowModule

{/*@skip-typecheck: Shows WorkflowModule usage*/}

```ts
import { WorkflowModule } from '@workflow/nest';

// Basic usage
WorkflowModule.forRoot()

// With options
WorkflowModule.forRoot({
  dirs: ['src/workflows'],
  outDir: '.nestjs/workflow',
  // Only with `workflow-nest build` in your build step: startup fails fast if
  // the bundles are missing. Defaults to true on Vercel, where they always are.
  skipBuild: true,
  moduleType: 'commonjs',  // if using SWC CommonJS compilation
  distDir: 'dist',          // where compiled .js files live
})
```

### CLI commands

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
| `--external <pkgs>` | Comma-separated packages to leave as bare `require()` calls instead of bundling, for dependencies resolved at runtime behind `try`/`catch`. Vercel builds only. | none |

## License

Apache-2.0
