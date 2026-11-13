---
"workflow": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
---

Implement and call `runs.setAttributes`, falling back to the deprecated `runs.experimentalSetAttributes` for Worlds that only provide the old name. The first-party Worlds keep the old name as an alias.
