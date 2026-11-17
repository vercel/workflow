---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Stop using opacity to set text colours in the observability UI. Muted text now uses the same Geist colour tokens as the Vercel dashboard, so it stays readable on every surface and in both themes.
