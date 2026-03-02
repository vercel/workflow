/**__internal_workflows{"steps":{"input.js":{"exportedStepArrow":{"stepId":"step//./input//exportedStepArrow"},"normalStep":{"stepId":"step//./input//normalStep"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
let stepArrow = async ()=>{
    return 1;
};
stepArrow.stepId = "step//./input//stepArrow";
export let exportedStepArrow = async ()=>{
    return 2;
};
exportedStepArrow.stepId = "step//./input//exportedStepArrow";
export async function normalStep() {
    return 3;
}
normalStep.stepId = "step//./input//normalStep";
