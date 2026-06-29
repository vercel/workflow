---
'workflow': minor
'@workflow/core': minor
'@workflow/world': minor
---

Add an `allowReservedAttributes` option to `start()` so framework-level callers can seed reserved `$`-prefixed run attributes at creation, matching the existing `experimental_setAttributes` option. The flag is carried through the resilient-start queue input so lazy run creation validates identically.
