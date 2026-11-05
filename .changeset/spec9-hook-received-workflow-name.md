---
"@workflow/core": patch
"@workflow/world": patch
---

Spec 9: `resumeHook()` and `resumeWebhook()` now send the run's workflow name with their `hook_received` write (`eventData.workflowName`, optional in the `@workflow/world` schema). The Vercel backend keys the payload by workflow name and otherwise reads the run stamp just to learn it before the write path reads the stamp again, so each resume of a spec 9 run saves one sequential DynamoDB round trip (four to three). Writes to older runs are unchanged, and the route is unchanged.
