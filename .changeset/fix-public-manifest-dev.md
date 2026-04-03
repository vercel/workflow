---
"@workflow/next": patch
---

Stop unconditionally setting `WORKFLOW_PUBLIC_MANIFEST=1` during `next dev`, which caused `public/.well-known/workflow/v1/manifest.json` to be created without the env var being explicitly set.
