---
"@workflow/next": minor
---

Add configurable `dirs` option to `withWorkflow()` to specify which directories to scan for workflow directives. This helps reduce memory usage and build times in large Next.js applications by allowing users to limit scanning to only directories containing workflows.
