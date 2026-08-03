---
"@workflow/world-vercel": minor
---

New internal API format: separately encode event metadata from user payloads. Eliminates the need for calling separate endpoints for ref resolution, which improves performance especially on longer runs.
