---
"@workflow/builders": major
"@workflow/next": major
"@workflow/rollup": major
---

**BREAKING CHANGE**: Remove `isWorkflowSdkFile` path-based serde exclusion. Serde discovery now uses AST-level verification via SWC detect mode across all integration paths (esbuild plugin, Next.js deferred builder, Next.js loader). This allows class definitions with serde symbols in SDK packages like `@workflow/core` to be discovered and bundled correctly.
