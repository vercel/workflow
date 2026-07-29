---
'@workflow/web': major
---

Replace Express with `srvx` in the standalone server. `startServer()` now resolves to a srvx `Server` instead of a Node `http.Server` (the Node server is still reachable via `server.node.server`), and static assets are served by `srvx/static`, adding ETag/`304`, `Last-Modified`, byte ranges and on-the-fly compression.
