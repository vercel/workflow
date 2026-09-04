---
'@workflow/builders': patch
'@workflow/core': patch
'@workflow/world': major
---

Keep schema-only World modules out of workflow VM bundles, prevent unknown attribute deletions from offsetting new keys, and safely ignore prototype-like event type names.
