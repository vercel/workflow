---
"@workflow/cli": patch
---

`workflow health` now gives its local server check the `--timeout` it was run with instead of a fixed 5 seconds, and reports a server that answered with an error status as such rather than as unreachable.
