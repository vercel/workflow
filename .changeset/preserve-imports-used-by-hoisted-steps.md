---
"@workflow/swc-plugin": patch
---

Fix two bugs affecting nested anonymous steps inside non-exported workflow functions: (1) module-level imports referenced only by hoisted step bodies were stripped by dead-code elimination, causing a `ReferenceError` at runtime; (2) the step ID generated for such steps was not namespaced under the workflow function name in step mode, so it did not match the ID looked up by the workflow-mode proxy, causing a "step not found" failure at runtime.
