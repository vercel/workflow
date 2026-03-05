import { sleep } from 'workflow';
/**__internal_workflows{"workflows":{"input.js":{"main":{"workflowId":"workflow//./input//main"}}},"steps":{"input.js":{"dude/myStep":{"stepId":"step//./input//dude/myStep"}}}}*/;
const dude = {
    myStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//dude/myStep")
};
export async function main() {
    await sleep(1000);
    await dude.myStep(1);
    return "hello world";
}
main.workflowId = "workflow//./input//main";
globalThis.__private_workflows.set("workflow//./input//main", main);
dude.myStep();
