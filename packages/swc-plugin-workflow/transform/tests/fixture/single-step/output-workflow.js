/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
export async function add(a, b) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//add")(a, b);
}
