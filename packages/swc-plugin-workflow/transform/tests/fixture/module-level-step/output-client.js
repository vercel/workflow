import { runStep as __private_run_step } from "workflow/api";
/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//input.js//step"},"stepArrow":{"stepId":"step//input.js//stepArrow"}}}}*/;
const localArrow = async (input)=>{
    return input.bar;
};
export async function step(input) {
    return __private_run_step("step", {
        arguments: [
            input
        ]
    });
}
export const stepArrow = async (input)=>__private_run_step("stepArrow", {
        arguments: [
            input
        ]
    });
