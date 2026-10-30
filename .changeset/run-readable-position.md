---
"@workflow/core": minor
---

Add `readable.position` to `run.getReadable()`: the stream position the value just read ended on, so a resumable consumer can carry a stored-chunk cursor instead of a count of values, which a write split across several chunks makes inaccurate.
