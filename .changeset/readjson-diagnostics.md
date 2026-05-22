---
'@workflow/world-local': patch
---

`readJSON` now surfaces the file path, on-disk size, and a snippet of the (possibly empty) content when it encounters a `SyntaxError`. Previously a corrupted or zero-byte file produced a bare `Unexpected end of JSON input` with no indication of which entity (run / event / hook / etc.) was affected, making concurrent-read races extremely hard to diagnose from CI logs.
