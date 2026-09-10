---
"@workflow/builders": patch
---

Generate per-file IDs for non-exported workspace package files (previously they collapsed to `name@version` and silently overwrote each other at runtime) and fail the build when two transformed files emit the same step or workflow ID — collisions that used to register silently last-write-wins now surface as a build error.
