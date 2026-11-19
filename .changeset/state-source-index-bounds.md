---
'@workflow/core': patch
---

Index the long strings of run inputs and hook payloads in memory linear in the payload, and write a reference to one only when it is shorter than the string. Check state that holds one object (or `Map`) many times once per object, so a small shared graph can't stall a replay or `workflow inspect`.
