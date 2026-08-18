---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/core': minor
---

Sealed-log event identity (specVersion 7): runs are stamped at spec 7, whose slot positions come from a per-run sequencer on the backend instead of writers racing conditional creates. The backend may fill a position whose writer died with a server-written `noop` event ("sealing"); the runtime skips noops during replay without advancing the deterministic clock, and the read union accepts the new event type. `SPEC_VERSION_SUPPORTS_SEALED_LOG` is exported from `@workflow/world`.
