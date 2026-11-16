---
"@workflow/world-postgres": minor
---

Warn once when `start()` could not get the flow route (its health check did not succeed, or the URL answered without the route registering), and once when an application server publishes without having called `start()`; the CLI and scripts stay quiet.
