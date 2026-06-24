---
'@workflow/web-shared': patch
---

Animate the new trace viewer's zoom/pan transitions with a single composited transform on the timeline instead of re-rendering every bar each frame, fixing span-click lag on large traces.
