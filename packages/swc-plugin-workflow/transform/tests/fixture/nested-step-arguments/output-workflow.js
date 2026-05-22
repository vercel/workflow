/**__internal_workflows{"workflows":{"input.js":{"outer":{"workflowId":"workflow//./input//outer"}}},"steps":{"input.js":{"step":{"stepId":"step//./input//outer/step"}}}}*/;
// `arguments` inside a nested `function`-form step body must NOT be treated
// as a closure variable — it's a per-function intrinsic binding that
// reflects the positional args the runtime passes via `stepFn.apply(thisVal,
// args)`. Without the `is_global_identifier("arguments")` exclusion, the
// hoisted body would gain `const { arguments } = ...` (a syntax error in
// strict mode) and the original `arguments[0]` access would silently break.
export async function outer() {
    var step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//outer/step");
    return step('hello');
}
outer.workflowId = "workflow//./input//outer";
globalThis.__private_workflows.set("workflow//./input//outer", outer);
