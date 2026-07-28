# @workflow/builders

Shared builder infrastructure for Workflow SDK. This package provides the base builder class and utilities used by framework-specific integrations.

## Overview

This package contains the core build logic for transforming workflow source files into deployable bundles. It is used by:

- `@workflow/cli` - For standalone/basic builds
- `@workflow/next` - For Next.js integration
- `@workflow/nitro` - For Nitro/Nuxt integration

## Key Components

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
const builder = new MyBuilder({
  // Other builder configuration...
  onAfterTransform: async ({
    mode,
    filename,
    absolutePath,
    source,
    code,
    workflowManifest,
  }) => {
    // Observe the accepted transform result.
  },
});
```

The observer is awaited after the transform's manifest entries have been
accepted. It cannot replace the generated code, and throwing aborts the build.
A source file may be observed multiple times across transform modes, bundles,
and watch rebuilds, so consumers should deduplicate results when necessary.

## Architecture

The builder system uses:

1. **esbuild** for bundling and tree-shaking
2. **SWC** for transforming workflow directives (`"use workflow"`, `"use step"`)
3. **Enhanced resolve** for TypeScript path mapping

## License

MIT
