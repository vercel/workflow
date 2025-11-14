/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//input.js//step"},"stepArrow":{"stepId":"step//input.js//stepArrow"}}}}*/;
'use step';
const localArrow = async (input)=>{
    return input.bar;
};
export var step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//step");
export const stepArrow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepArrow");
Object.defineProperty(step, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//step",
    writable: false,
    enumerable: false,
    configurable: false
});
Object.defineProperty(stepArrow, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//stepArrow",
    writable: false,
    enumerable: false,
    configurable: false
});
