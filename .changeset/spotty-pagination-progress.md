---
'@workflow/core': patch
---

Fail event pagination cleanly when a page reports more results but adds no new events, bounding the load loop against non-progressing cursor responses.
