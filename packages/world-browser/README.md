# @workflow/world-browser

Browser-based World implementation for Workflow DevKit using SharedWorker and Turso WASM.

## Overview

This package enables running workflows entirely in the browser using:

- **SharedWorker** for background execution across tabs
- **Turso WASM** (SQLite) for persistent storage via OPFS
- **Web Streams API** for streaming support

## Installation

```bash
npm install @workflow/world-browser
```

## Usage

### Define Workflows (same syntax as server)

```typescript
// src/workflows/browser/my-workflow.ts
async function myStep(x: number) {
  'use step';
  return x * 2;
}

export async function myWorkflow(input: { value: number }) {
  'use workflow';
  return await myStep(input.value);
}
```

### Configure Next.js

```typescript
// next.config.ts
import { withWorkflow } from '@workflow/next';

export default withWorkflow(nextConfig, {
  browser: {
    include: ['src/workflows/browser/**/*.ts'],
  },
});
```

### Call Workflows

```typescript
// In a client component
import { myWorkflow } from '@/workflows/browser/my-workflow';

// Just call it like a regular function!
const result = await myWorkflow({ value: 21 });
console.log(result); // 42
```

## Features

- **Same syntax** as server workflows (`'use workflow'`, `'use step'`)
- **Offline-capable** - workflows persist in browser storage
- **Multi-tab support** via SharedWorker
- **Deterministic execution** for reliable replay

## License

Apache-2.0
