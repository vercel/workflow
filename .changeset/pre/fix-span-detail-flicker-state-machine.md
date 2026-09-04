---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Fix the run trace detail panel flickering its Input/Output sections when navigating between spans. Span detail is now driven by a single selection-derived state machine (`useSelectedSpanDetail`) whose loading state stays in phase with the selected span, replacing the fetch flag that lagged selection by a few renders.
