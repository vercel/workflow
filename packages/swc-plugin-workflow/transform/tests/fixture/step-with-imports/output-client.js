import { runStep as __private_run_step } from "workflow/api";
import { usefulHelper// do not remove
 } from './utils';
import * as useful from './useful'; // do not remove
/**__internal_workflows{"steps":{"input.js":{"processData":{"stepId":"step//input.js//processData"}}}}*/;
export async function processData(data) {
    return __private_run_step("processData", {
        arguments: [
            data
        ]
    });
}
export function normalFunction() {
    // since this function is exported we can't remove it
    useful.doSomething();
    return usefulHelper();
}
