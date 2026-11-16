---
"@workflow/web": patch
---

Switch tabs in the observability UI without waiting on a server round trip: the root loader no longer re-runs on navigations that don't change its data, and tab state updates optimistically on the click.
