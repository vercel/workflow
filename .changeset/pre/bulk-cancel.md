---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
---

Add a bulk run cancellation primitive. `@workflow/world` defines the `BulkCancelWorkflowRuns*` contract and an optional `runs.cancelMany`; `@workflow/world-vercel` implements it via a single `POST /v4/runs/cancel`; `@workflow/core` adds a `cancelRuns` helper that uses `cancelMany` when available and falls back to bounded-concurrency single-run cancellation.
