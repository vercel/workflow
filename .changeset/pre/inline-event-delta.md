---
'workflow': patch
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-vercel': patch
---

Skip the per-step incremental `events.list` round-trip in the inline sequential loop by consuming an event-log delta returned from the step's terminal write (gated to the single-step case with no open hooks or waits).

Add the opt-in `CreateEventParams.sinceCursor` contract so a step-terminal `events.create` can return the event-log delta since that cursor (via `EventResult.events`/`cursor`/`hasMore`).

Return the inline delta from a step-terminal write when `sinceCursor` is supplied, computed identically to `events.list` so the consumed prefix cannot skew from the server log.

Forward `sinceCursor` over the v4 wire in `@workflow/world-vercel` so the server can return the delta on a step-terminal response; older servers ignore it and the runtime falls back to `events.list`.
