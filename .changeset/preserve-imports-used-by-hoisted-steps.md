---
"@workflow/swc-plugin": patch
---

Fix three bugs affecting nested step functions that get hoisted out of an enclosing function (workflows in any declaration form, plus regular factory-style functions returning objects with step methods):

1. Module-level imports referenced only by hoisted step bodies were stripped by dead-code elimination, causing a `ReferenceError` at runtime.
2. The step ID generated for nested anonymous steps inside a non-exported workflow declared as `const foo = async () => {}` or `const foo = async function() {}` was not namespaced under the workflow name in step mode, so it did not match the ID looked up by the workflow-mode proxy and caused a runtime "step not found" failure. Steps inside `async function foo()` workflows were already namespaced correctly; this brings the const-arrow and const-fn-expression forms into agreement.
3. The `__internal_workflows` manifest comment reported nested anonymous step IDs without the workflow-name prefix even though the runtime registration and proxy lookup used the prefixed form, so downstream tooling (e.g. builders consuming the manifest) saw the wrong step ID.
