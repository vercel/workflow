/**__internal_workflows{"steps":{"input.js":{"badStep":{"stepId":"step//input.js//badStep"}}}}*/;
export var badStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//badStep");
export const badWorkflow = async ()=>{
    console.log('hello');
    // Error: directive must be at the top of function
    'use workflow';
    return true;
};
Object.defineProperty(badStep, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//badStep",
    writable: false,
    enumerable: false,
    configurable: false
});
