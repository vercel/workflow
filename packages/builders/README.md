# @workflow/builders

Shared builder infrastructure for Workflow SDK. This package provides the base builder class and utilities used by framework-specific integrations.

## Overview

This package contains the core build logic for transforming workflow source files into deployable bundles. It is used by:

- `@workflow/cli` - For standalone/basic builds
- `@workflow/next` - For Next.js integration
- `@workflow/nitro` - For Nitro/Nuxt integration

## Key components

- **BaseBuilder**: Abstract base class providing common build logic
- **Build plugins**: esbuild plugins for workflow transformations
- **SWC integration**: Compiler plugin integration for workflow directives

## Usage

This package is typically not used directly. Instead, use one of the framework-specific packages that extend `BaseBuilder`:

```typescript
import { BaseBuilder } from '@workflow/builders';

class MyBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // Implement builder-specific logic
  }
}
```

### Observing transforms

Builder configurations can provide an optional `onAfterTransform` observer for
tooling that derives metadata from the exact SWC output used by a build:

```typescript
import type { WorkflowAfterTransformHook } from '@workflow/builders';

// Pass as `onAfterTransform` in the builder configuration.
const onAfterTransform: WorkflowAfterTransformHook = async ({
  mode,
  filename,
  absolutePath,
  source,
  code,
  workflowManifest,
}) => {
  // Observe the accepted transform result.
};
```

The observer is awaited after the transform's manifest entries have been
accepted. It cannot replace the generated code, and throwing aborts the build.
A source file may be observed multiple times across transform modes, bundles,
and watch rebuilds, so consumers should deduplicate results when necessary.

### Observing completed bundles

Builder configurations can also provide an `onAfterBundle` observer. It runs
once after a combined workflow bundle and its manifest have been written
successfully, and again after each successful watch rebuild:

```typescript
import type { WorkflowAfterBundleHook } from '@workflow/builders';

// Pass as `onAfterBundle` in the builder configuration.
const onAfterBundle: WorkflowAfterBundleHook = async ({
  buildTarget,
  workingDir,
  workflowManifest,
  artifacts,
}) => {
  // Publish or otherwise derive data from the completed bundle.
};
```

Every invocation has exactly three artifact descriptors, ordered as `steps`,
`workflows`, and `manifest`. Paths are absolute. These are the files that make
up the completed combined workflow bundle boundary. Webhook, source-map,
diagnostics, public-manifest copies, and optional client outputs do not produce
separate invocations or artifact descriptors.

The observer is awaited, and throwing rejects the build or rebuild. It is not
called when bundle or manifest generation fails. Build systems can rebuild
unchanged inputs, so consumers are expected to make side effects idempotent.

## Architecture

The builder system uses:

1. **esbuild** for bundling and tree-shaking
2. **SWC** for transforming workflow directives (`"use workflow"`, `"use step"`)
3. **Enhanced resolve** for TypeScript path mapping

## License

MIT
