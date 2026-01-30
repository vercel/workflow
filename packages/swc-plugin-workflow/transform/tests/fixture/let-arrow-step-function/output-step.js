import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"exportedStepArrow":{"stepId":"step//./input//exportedStepArrow"},"normalStep":{"stepId":"step//./input//normalStep"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
let stepArrow = async ()=>{
    return 1;
};
export let exportedStepArrow = async ()=>{
    return 2;
};
export async function normalStep() {
    return 3;
}
registerStepFunction("step//./input//stepArrow", stepArrow);
registerStepFunction("step//./input//exportedStepArrow", exportedStepArrow);
registerStepFunction("step//./input//normalStep", normalStep);
