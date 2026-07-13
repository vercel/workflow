---
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Add attribute discovery and filtering to the `world.analytics` namespace: `analytics.attributes.list()` lists the distinct attribute keys observed on runs (with run counts and first/last seen timestamps), `analytics.attributes.listValues({ key })` lists the distinct values for a key with latest-write-wins run counts, and `analytics.runs.list({ attributes: { key: value } })` restricts the runs listing to runs whose latest attribute snapshot matches every provided pair.
