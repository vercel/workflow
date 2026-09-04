---
'@workflow/web': patch
---

The hooks list now reads from the metadata-only `world.analytics` namespace when the backend provides one (falling back to the runtime storage APIs otherwise). A hook's secret token is no longer included in list rows — it is fetched one hook at a time via `world.hooks.get` only when the user copies the token or resumes the hook.
