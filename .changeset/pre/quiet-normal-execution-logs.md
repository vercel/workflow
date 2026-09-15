---
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/utils': patch
'@workflow/world': patch
---

Stop logging on healthy workflow execution: the breadcrumbs that only described the runtime working correctly now print under `DEBUG=workflow:*`. Warnings and errors are unchanged.
