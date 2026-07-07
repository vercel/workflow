---
'@workflow/web': patch
---

Replace Previous/Next pagination on the runs table with infinite scroll. Pages are fetched via the server cursor as the user nears the bottom of the list (IntersectionObserver sentinel with prefetch margin), appended with per-run dedup, and the footer shows the loaded count plus the analytics lookback window when the backend provides one.
