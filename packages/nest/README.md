# @workflow/nest

NestJS integration for Workflow DevKit.

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

  // Skip building in production when bundles are pre-built
  skipBuild: false,

  // SWC module type: 'es6' (default) or 'commonjs'
  // Set to 'commonjs' if your NestJS project compiles to CJS via SWC
  moduleType: 'es6',

  // Directory where NestJS compiles .ts to .js (default: 'dist')
  // Only used when moduleType is 'commonjs'
  // Should match the outDir in your tsconfig.json
  distDir: 'dist',
});
```

## How It Works

The `@workflow/nest` package provides:

1. **WorkflowModule** - A NestJS module that handles workflow bundle building and HTTP routing
2. **WorkflowController** - Handles workflow and step execution requests at `.well-known/workflow/v1/`
3. **NestLocalBuilder** - Builds workflow bundles (steps.mjs, workflows.mjs) from your source files
4. **CLI** - Generates `.swcrc` configuration with the SWC plugin properly resolved

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

# Show help
npx @workflow/nest --help
```

## License

Apache-2.0
