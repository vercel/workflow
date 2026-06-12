# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Remote ref cache

Event replay reads resolve immutable remote refs through a bounded in-process
byte cache, reducing repeated backend reads without allowing warm instances to
retain unbounded workflow payload data. The cache stores encoded bytes rather
than decoded values, so each caller gets a fresh decoded object and cannot
mutate a cached payload through a shared reference.

This cache is specific to `world-vercel`, because remote ref descriptors and
their fetch endpoint are adapter transport details rather than part of the
generic `World` contract.

## Custom dispatcher

HTTP requests (including the queue) default to a shared undici `RetryAgent` that handles connection pooling and retries. Pass a custom `dispatcher` to override it — e.g. to tune undici on newer Node runtimes:

```ts
import { Agent } from 'undici';
import { createVercelWorld } from '@workflow/world-vercel';
import { setWorld } from '@workflow/core/runtime';

setWorld(createVercelWorld({ dispatcher: new Agent({ connections: 16 }) }));
```
