---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Use theme-aware palette tokens for run status dots. Running is blue, completed is teal, failed is red, and pending or cancelled is gray, in both the status badge and the runs table status filter. The unthemed `bg-*-cyan`/`-warning`/`-error` status colours are removed from `styles.css`.
