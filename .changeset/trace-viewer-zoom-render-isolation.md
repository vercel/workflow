---
'@workflow/web-shared': patch
---

Fix trace viewer lag when selecting/zooming a span. Timeline marker tooltips now share a single `ContextCardProvider` instead of each tick self-mounting its own portal/observer/listener, the detail panel and event list no longer re-render on every frame of the click-to-zoom animation, and the per-frame span-gap pass is skipped unless the Alt-key delta overlay is active.
