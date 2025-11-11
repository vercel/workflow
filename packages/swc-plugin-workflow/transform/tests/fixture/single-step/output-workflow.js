/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
export async function add(a, b) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//add")(a, b);
}
Object.defineProperty(add, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//add",
    writable: false,
    enumerable: false,
    configurable: false
});
