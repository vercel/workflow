import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//step":{"name":"step","source":"input.js"},"step//./input//stepArrow":{"name":"stepArrow","source":"input.js"}}}*/;
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
