---
'@workflow/world-local': patch
---

Hold the Hook token claim lock through the `hook_created` publish so two processes creating the same hook can no longer both publish a `hook_created` event (the adopter could publish at the claimed slot first and the claimer then bumped past it).
