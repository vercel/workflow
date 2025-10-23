import { runStep as __private_run_step } from "workflow/api";
/**__internal_workflows{"steps":{"input.js":{"badStep":{"stepId":"step//input.js//badStep"}}}}*/;
export async function badStep() {
    return __private_run_step("badStep", {
        arguments: []
    });
}
export const badWorkflow = async ()=>{
    console.log('hello');
    // Error: directive must be at the top of function
    'use workflow';
    return true;
};
