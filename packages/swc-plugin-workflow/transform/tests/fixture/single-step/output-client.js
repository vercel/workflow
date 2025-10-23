import { runStep as __private_run_step } from "workflow/api";
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
export async function add(a, b) {
    return __private_run_step("add", {
        arguments: [
            a,
            b
        ]
    });
}
