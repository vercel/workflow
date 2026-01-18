---
"@workflow/web": patch
"@workflow/web-shared": patch
"@workflow/cli": patch
---

Use env variables instead of query params for world config (like WORKFLOW_TARGET_WORLD)

**BREAKING CHANGE**: The OSS web UI is now locked to a single world and will not let you change world using query params
