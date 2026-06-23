---
'@workflow/web-shared': patch
---

Fix trace viewer lag when selecting a span: the detail panel and event list no longer re-render on every frame of the click-to-zoom animation.
