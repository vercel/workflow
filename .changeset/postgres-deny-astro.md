---
"@workflow/astro": minor
---

The generated flow route builds its `workflowEntrypoint()` once per module instead of once per request, and exposes its in-process entry on `POST`, so a World that delivers in process (the Postgres World) can be handed the route.
