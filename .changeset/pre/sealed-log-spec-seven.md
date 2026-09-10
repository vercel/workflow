---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/core': minor
---

New runs are created with the sealed-log event identity (specVersion 7). A sealed-log run's event positions are assigned by the backend before each write commits, so concurrent writers never contend for a position. A position whose writer dies is closed by the backend with a `noop` event; replay steps over those without delivering them or advancing the deterministic clock. Set `WORKFLOW_SEALED_LOG=0` to put a deployment back on the previous scheme. Every runtime reads sealed logs either way, and a run's version is fixed at creation, so the setting only affects new runs.
