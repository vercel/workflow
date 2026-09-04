---
'@workflow/web-shared': patch
---

Render sealed log positions (`noop` events) as the log rows they are: shown in event lists, excluded from span geometry and trace duration, since a seal's timestamp belongs to whichever reader wrote it rather than to the run.
