---
"@workflow/core": patch
---
Spec 9 (Node engine): when another writer's event lands after the workflow VM decided, run the next pass on the retained VM instead of replaying the whole log. A hook payload that arrives while the previous step finishes no longer costs a full replay.
