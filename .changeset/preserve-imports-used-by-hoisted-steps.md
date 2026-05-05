---
"@workflow/swc-plugin": patch
---

Preserve module-level imports referenced by step functions hoisted out of workflow bodies. Previously, dead-code elimination ran before nested steps were hoisted to the module top level, causing the step bundle to drop imports that the hoisted step body still depended on (resulting in a `ReferenceError` at runtime).
