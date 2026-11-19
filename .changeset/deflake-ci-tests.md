---
"@workflow/world-local": patch
"@workflow/world-testing": patch
---

On Windows, tagged `clear()`s running side by side no longer fail with `EPERM` while deleting the JSON data of an earlier release, and two clears of different tags no longer leave behind an empty directory each kept for the other's file. In the shared World tests, wait for the sleep's timer delivery before checking the sleep workflow's flow invocation count, and run the `wf` CLI without blocking the test process.
