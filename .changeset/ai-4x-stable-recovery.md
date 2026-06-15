---
"@workflow/ai": patch
---

Re-release `@workflow/ai` on the 4.x stable line. Versions 5.0.0, 6.0.0, and 7.0.0 were published to the `latest` dist-tag in error: a changesets peer-dependency misconfiguration force-bumped a full major on every `workflow` minor release, even though `@workflow/ai` had no breaking changes. Those versions are deprecated — `^4` remains the correct stable range.
