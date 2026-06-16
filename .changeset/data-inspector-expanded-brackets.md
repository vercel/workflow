---
'@workflow/web-shared': patch
---

Rework the data inspector's JSON rendering to match the Vercel dashboard 1:1: bracket notation (`{ … }` / `[ … ]`), pink keys, typed value colors, `▸`/`▾` disclosure icons, trailing commas, and a `...` collapsed indicator. Replaces the `react-inspector` engine with an in-house tree renderer while keeping the workflow-specific value handling (StreamRef/RunRef badges, encrypted markers, decoded byte streams, dates, class instances).
