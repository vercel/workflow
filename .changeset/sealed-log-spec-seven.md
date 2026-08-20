---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/core': minor
---

Add the sealed-log event identity (specVersion 7), opt-in via `WORKFLOW_SEALED_LOG=1`. A sealed-log run's event positions are assigned by the backend before each write commits, so concurrent writers never contend for a position. A position whose writer dies is closed by the backend with a `noop` event; replay steps over those without delivering them or advancing the deterministic clock. Every runtime reads sealed logs regardless of the setting, and a run's version is fixed at creation, so enabling it affects only new runs.
