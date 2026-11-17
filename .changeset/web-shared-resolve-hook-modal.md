---
'@workflow/web-shared': patch
'@workflow/web': patch
---

`ResolveHookModal` is built on Radix Dialog: focus is trapped while open, moves to the payload field, and returns to the trigger on close. It uses the shared `Button`, `Kbd` and type scale, shows invalid JSON inline, and keeps the payload when sending fails.
