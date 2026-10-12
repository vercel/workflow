---
"@workflow/world-local": patch
---

The in-band writer fence holds across processes: a run's in-band count lives on disk under a lock file, so a stale in-band write from one process is refused after another process on the same data directory wrote in-band (before, each process kept its own count and refused nothing from another). The count also survives a restart.
