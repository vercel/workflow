# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

Event replay reads resolve immutable remote refs through a bounded in-process
byte cache, reducing repeated backend reads without allowing warm instances to
retain unbounded workflow payload data.
