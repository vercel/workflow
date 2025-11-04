# @workflow/builders

Shared builder infrastructure for Workflow DevKit. This package provides the base builder class and utilities used by framework-specific integrations.

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

## Architecture

The builder system uses:

1. **esbuild** for bundling and tree-shaking
2. **SWC** for transforming workflow directives (`"use workflow"`, `"use step"`)
3. **Enhanced resolve** for TypeScript path mapping

## License

MIT
