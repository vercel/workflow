---
'@workflow/web-shared': patch
---

Fix the trace viewer click-to-zoom animation jumping/stuttering on large traces. The easing clock now starts on the first animation frame (so a heavy detail-panel mount can't make the zoom skip ahead), the panel opens as a low-priority transition so it doesn't block the animation, and the panel/event list/marker tooltips no longer do redundant work on every animation frame.
