---
'@workflow/nitro': patch
---

Keep rewriting the generated bundles even when unchanged, since the dev handler cache-busts `steps.mjs` off the mtime of `workflows.mjs` and a step-body-only edit would otherwise serve stale code.
