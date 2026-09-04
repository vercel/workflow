---
'@workflow/world-vercel': patch
---

Honor the server's explicit pagination flag when listing run events, avoiding one extra empty-page request per event-log load on replay.
