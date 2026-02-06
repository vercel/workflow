import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//exportedStepArrow":{"name":"exportedStepArrow","source":"input.js"},"step//./input//normalStep":{"name":"normalStep","source":"input.js"},"step//./input//stepArrow":{"name":"stepArrow","source":"input.js"}}}*/;
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
