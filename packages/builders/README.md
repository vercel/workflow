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

### Running a hook after bundle artifacts are complete

Low-level builder configurations can provide an `onAfterBundle` hook. It runs
once after a combined workflow bundle and its manifest have been written
successfully, and again after each successful watch rebuild:

```typescript
import type { WorkflowAfterBundleHook } from '@workflow/builders';

// Pass as `onAfterBundle` in the builder configuration.
const onAfterBundle: WorkflowAfterBundleHook = async ({
  buildTarget,
  workingDir,
  artifacts,
}) => {
  const manifestPath = artifacts.find(
    (artifact) => artifact.kind === 'manifest'
  )!.path;
  // Read manifestPath or derive other data from the completed bundle.
};
```

Every invocation has exactly three artifact descriptors, ordered as `steps`,
`workflows`, and `manifest`. `workingDir` and every artifact path are absolute;
relative output paths are resolved against the builder's `workingDir` before
the files are written. The `manifest` artifact is authoritative: it points to
the serialized manifest with its `version`, converted entries, and workflow
graphs. The hook does not expose the internal SWC manifest shape.

This is a **bundle boundary**, not the end of the builder's complete `build()`
method. Framework-specific webhook, source-map, diagnostics, public-manifest,
function-configuration, and optional client outputs may not exist yet and do
not produce separate invocations or artifact descriptors. Code that needs one
of those later outputs must run at a framework-specific build-completion hook
instead.

`onAfterBundle` is currently a builder API. Direct `StandaloneBuilder` and
`VercelBuildOutputAPIBuilder` configurations can provide it. The internal Next,
Nest, SvelteKit, and Astro builders reach the same bundle boundary, but their
public framework configuration entrypoints do not forward this option yet.
Builders that do not call `createManifest()`, including `SimBuilder`, do not
invoke it.

The hook is awaited serially, including during watch rebuilds, so it should stay
fast or hand expensive work to another system. A hook failure is thrown as
`onAfterBundle hook failed`, with the original thrown value available as its
`cause`. The three bundle files have already been written at that point and are
not rolled back. A direct build rejects; a framework watcher may catch and log
that rejection according to its normal error policy.

The hook is not called when bundle or manifest generation fails. Each
successful bundle write authorizes at most one hook call, and a later failed
rebuild invalidates the prior completion. Build systems can rebuild unchanged
inputs, so consumers should still make external side effects idempotent. The
hook runs in the build process with the builder's filesystem access and receives
absolute local paths; only install trusted hooks.

## Architecture

The builder system uses:

1. **esbuild** for bundling and tree-shaking
2. **SWC** for transforming workflow directives (`"use workflow"`, `"use step"`)
3. **Enhanced resolve** for TypeScript path mapping

## License

MIT
