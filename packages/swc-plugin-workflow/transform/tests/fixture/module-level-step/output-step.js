import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//./input//step"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
async function local(input) {
    return input.foo;
}
const localArrow = async (input)=>{
    return input.bar;
};
export async function step(input) {
    return input.foo;
}
export const stepArrow = async (input)=>{
    return input.bar;
};
registerStepFunction("step//./input//step", step);
registerStepFunction("step//./input//stepArrow", stepArrow);
