/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//input.js//step"},"stepArrow":{"stepId":"step//input.js//stepArrow"}}}}*/;
'use step';
const localArrow = async (input)=>{
    return input.bar;
};
export async function step(input) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//step")(input);
}
export const stepArrow = async (input)=>globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepArrow")(input);
Object.defineProperty(step, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//step",
    writable: false,
    enumerable: false,
    configurable: false
});
