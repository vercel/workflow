---
'@workflow/world-postgres': patch
'@workflow/world-local': patch
'@workflow/core': patch
'@workflow/world': patch
---

A replay that writes a branch decision now tells the world which pending steps, hooks and sleeps it is waiting on, and the world refuses the write when one of them was already settled by an event the replay had not read. The replay reloads and picks the branch the log supports instead of corrupting it. Set `WORKFLOW_AWAITED_RESOLUTION_FENCE=0` to turn this off.
