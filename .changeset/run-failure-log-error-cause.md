---
'@workflow/core': patch
---

Render the `cause` chain of a failed run's error in the run-failure log, so a wrapper such as `TypeError: fetch failed` — whose own message and stack say nothing — reports the socket, DNS or TLS failure underneath it.
