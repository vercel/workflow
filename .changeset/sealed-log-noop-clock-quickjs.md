---
'@workflow/web-shared': patch
'@workflow/world': patch
'@workflow/core': patch
---

Fix the QuickJS replay engine advancing the deterministic clock to a sealed position's timestamp. A `noop` is written by the backend when it seals a position whose writer died, so its timestamp is the sealer's wall clock and can postdate the events around it. The `node:vm` engine already skipped it; QuickJS did not, so the same log replayed with different `Date.now()` values on the two engines. `isSealedNoopEvent` is now exported from `@workflow/world` as the single test both engines and the trace viewer use. Sealed positions also no longer count toward a run's event ceiling or disqualify it from latency telemetry.
