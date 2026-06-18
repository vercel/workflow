---
'@workflow/builders': patch
'@workflow/next': patch
---

Pass the bundle's workflow source filenames to `workflowEntrypoint` in generated routes so the workflow VM script is precompiled at module-init time.
