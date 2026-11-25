---
'@workflow/web': patch
'@workflow/web-shared': patch
'@workflow/world': patch
---

Simplify the run header: drop its box border and the Run ID and Events fields, label storage plain "Storage" with a shorter note behind a dotted underline instead of a help icon, and show every relative time (the run header, the runs and hooks tables, and Last refreshed) with the relative time card instead of an underlined tooltip. `@workflow/web-shared` now exports `TimestampTooltip` and `ContextCardProvider`.
