---
'@workflow/swc-plugin': patch
---

Give same-named nested steps in different block scopes distinct step IDs. Previously, two steps such as `const act = async () => { 'use step' }` declared in separate `if`/`else` branches of one workflow were both registered as `<workflow>/act`, so the later step's body replaced the earlier one. The first occurrence keeps its existing ID; later ones get a `~N` suffix (e.g. `<workflow>/act~1`). This also applies to step functions declared on same-named object literals. Workflow mode now reuses the step names that step mode assigns, so the two can't map one ID to different step bodies. Object property step keys containing `~` are now rejected, and colliding hoisted bindings are renamed.

Steps nested in plain (non-workflow) functions are now looked up under the same ID they are registered with. A module-level declaration that shares a nested step's name is no longer treated as a step in workflow mode.

The `__internal_workflows` manifest now keys steps hoisted out of a workflow by their namespaced name (e.g. `myWorkflow/act`) instead of the bare local name, so same-named nested steps in different workflows are all listed and checked for duplicate IDs.
