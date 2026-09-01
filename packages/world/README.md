# @workflow/world

Core interfaces and types for Workflow SDK storage backends.

This package defines the `World` interface that abstracts workflow storage, queuing, authentication, and streaming operations. Implementation packages like `@workflow/world-local` and `@workflow/world-vercel` provide concrete implementations.

Used internally by `@workflow/core` and world implementations. Should not be used directly in application code.

Worlds may optionally expose `world.journals`, an experimental compare-and-set
store for opaque durable state whose lifetime is independent of workflow runs.
The namespace is absent when a World does not support this capability.
