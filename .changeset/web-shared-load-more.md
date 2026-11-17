---
'@workflow/web-shared': patch
'@workflow/web': patch
---

`LoadMoreButton` is now the shared small secondary `Button` instead of injecting its own CSS. Its label is "Load More" and stays the same while loading. The event list footer places the label and the button side by side so they no longer overlap at narrow widths.
