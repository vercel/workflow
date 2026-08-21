---
'@workflow/world-testing': patch
---

The event-id conformance test now floors a run's stamped `specVersion` at `mintedSpecVersion()` rather than `SPEC_VERSION_CURRENT`, so a World is not failed for stamping the version it was told to stamp while a spec bump is staged.
