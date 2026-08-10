---
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/core': patch
'@workflow/world': patch
---

**Breaking**: SpecVersion 6: Event IDs are now a dense per-run slot number, allocated by the world at publish time so a rejected write leaves no gap in the event log. A replay tells the world how many events it had read and gets back the ones it did not see, so an event that arrives from outside the replay. An event landing ahead of an event the replay wrote no longer fails the run with `CORRUPTED_EVENT_LOG`: it is held for whichever part of the workflow awaits it. A gap in the numbering fails the run instead of being replayed over.
