# @workflow/world

Core interfaces and types for Workflow SDK storage backends.

This package defines the `World` interface that abstracts workflow storage, queuing, authentication, and streaming operations. Implementation packages like `@workflow/world-local` and `@workflow/world-vercel` provide concrete implementations.

Used internally by `@workflow/core` and world implementations. Should not be used directly in application code.

## Run-tree purge

Frameworks that own a stable lineage attribute can use the optional
`World.purgeRunTree()` retention primitive. A supporting World must fence new
writes, reject active trees with `EntityConflictError`, remove the root,
matching descendants, and all backend-owned entities, and make retries
idempotent. Callers must check `world.capabilities?.runTreePurge === true`
before relying on this operation.
