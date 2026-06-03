# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Backend Deprecation Notices

When workflow-server returns endpoint lifecycle headers, this adapter warns
once by default. Tools embedding the adapter can provide `onDeprecation` to
render structured notices themselves:

```ts
import { createVercelWorld } from '@workflow/world-vercel';

createVercelWorld({
  onDeprecation(notice) {
    console.warn(notice.endpoint, notice.preferredEndpoint);
  },
});
```
