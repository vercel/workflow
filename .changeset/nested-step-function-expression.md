---
'@workflow/swc-plugin': patch
---

A `"use step"` function expression bound to a variable inside a workflow or another function (`const send = async function () { "use step"; ... }`) is now a nested step like the arrow form: hoisted, namespaced by the enclosing function and given the variables it captures. It was treated as a module-level step, so its step was never registered and the run failed with "Step ... is not registered".
