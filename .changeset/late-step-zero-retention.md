---
"@workflow/world-local": patch
---

Scrub only what a step that settles after its `experimental_retention: 0` run ended wrote, instead of the whole run again, and answer that write with the scrubbed step and event
