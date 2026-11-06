---
'@workflow/world-local': patch
---

Honor a stream reader's `startIndex` when it is past the chunks written so far. The reader used to deliver every chunk written after it opened, including the ones before `startIndex`, and a reader opened past the end of a closed stream never ended.
