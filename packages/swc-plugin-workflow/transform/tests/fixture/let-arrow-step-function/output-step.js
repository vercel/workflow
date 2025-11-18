import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"exportedStepArrow":{"stepId":"step//input.js//exportedStepArrow"},"normalStep":{"stepId":"step//input.js//normalStep"},"stepArrow":{"stepId":"step//input.js//stepArrow"}}}}*/;
let stepArrow = async ()=>{
    return 1;
};
export let exportedStepArrow = async ()=>{
    return 2;
};
export async function normalStep() {
    return 3;
}
registerStepFunction("step//input.js//stepArrow", stepArrow);
registerStepFunction("step//input.js//exportedStepArrow", exportedStepArrow);
registerStepFunction("step//input.js//normalStep", normalStep);
