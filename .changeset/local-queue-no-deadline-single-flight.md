---
'@workflow/world-local': patch
'@workflow/core': patch
---

Stop re-executing long-running inline steps while they are still running. World-local queue deliveries no longer default to 30s headers/body deadlines, which redelivered a live message; `WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS` and `WORKFLOW_LOCAL_BODY_TIMEOUT_MS` now opt in to a deadline. The runtime also routes lazy and pre-claimed inline steps through the in-process single-flight, so any redelivery of the same message waits for the running body instead of executing it again.
