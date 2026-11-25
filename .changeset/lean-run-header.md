---
'@workflow/web': patch
'@workflow/web-shared': patch
---

Simplify the run header: drop its box border and the Run ID and Events fields, label storage plain "Storage" with its note behind a dotted underline instead of a help icon, and show the Queued, Started, and Completed times with the relative time card instead of an underlined tooltip. `@workflow/web-shared` now exports `TimestampTooltip` and `ContextCardProvider`.
