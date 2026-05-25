---
"@workflow/web-shared": patch
"@workflow/web": patch
---

Add server-backed exact ID search to the Events tab. Pasting a full correlation ID (`step_`, `wait_`, or `hook_`) or event ID (`evnt_`) fetches matching events from the API instead of filtering the loaded page client-side.
