---
'@workflow/world-local': patch
---

Deliver stream chunks in the order they were written. A reader that opened, or polled, while chunks were being written could get a later chunk before an earlier one, and could get a chunk twice. Writes to one stream now land in order, including a `writeMulti` group and concurrent writes, and the reader holds live chunks while it reads from disk.
