---
"@workflow/world": minor
"@workflow/builders": minor
"@workflow/core": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
---

Add an optional `namespace` parameter that scopes queue topic prefixes to `__{namespace}_wkf_workflow_*`. This allows configuring multiple frameworks in the same deployment without queue topic collision.
