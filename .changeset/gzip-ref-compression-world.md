---
'@workflow/world': minor
---

Bump `SPEC_VERSION_CURRENT` to 5 (`SPEC_VERSION_SUPPORTS_COMPRESSION`): runs at spec 5+ may contain gzip-compressed payloads, and older SDKs reject them via `requiresNewerWorld()` instead of failing on individual payloads.
