# @workflow/world

Core interfaces and types for Workflow SDK storage backends.

This package defines the `World` interface that abstracts workflow storage, queuing, authentication, and streaming operations. Implementation packages like `@workflow/world-local` and `@workflow/world-vercel` provide concrete implementations.

Used internally by `@workflow/core` and world implementations. Should not be used directly in application code.

`world.events.listByCorrelationId()` accepts an optional `runId` to limit
matching events to a single workflow run while preserving unscoped queries for
backends and callers that need cross-run results.
