import { registerStepFunction } from "workflow/internal/private";
import { something } from './somewhere';
import { sleep } from 'workflow';
/**__internal_workflows{"workflows":{"input.js":{"main":{"workflowId":"workflow//./input//main"}}},"steps":{"input.js":{"dude/myStep":{"stepId":"step//./input//dude/myStep"}}}}*/;
var dude$myStep = async function(a) {
    something();
    return a + 1;
};
const dude = {
    myStep: dude$myStep
};
export async function main() {
    throw new Error("You attempted to execute workflow main function directly. To start a workflow, use start(main) from workflow/api");
}
main.workflowId = "workflow//./input//main";
dude.myStep();
registerStepFunction("step//./input//dude/myStep", dude$myStep);
