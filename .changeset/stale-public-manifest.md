---
"@workflow/builders": patch
"@workflow/next": patch
"@workflow/sveltekit": patch
"@workflow/astro": patch
---

Remove the public manifest an earlier build generated once `WORKFLOW_PUBLIC_MANIFEST` is no longer set, so it stops being served
