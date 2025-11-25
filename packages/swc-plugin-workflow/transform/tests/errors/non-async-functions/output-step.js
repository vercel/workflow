// Error: sync function with use step
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//input.js//validWorkflow"}}},"steps":{"input.js":{"validStep":{"stepId":"step//input.js//validStep"}}}}*/;
export function syncStep() {
    'use step';
    return 42;
}
// Error: sync arrow function with use workflow
export const syncWorkflow = ()=>{
    'use workflow';
    return 'test';
};
// Error: sync method with use step
const obj = {
    syncMethod () {
        'use step';
        return true;
    }
};
// These are ok
export async function validStep() {
    return 42;
}
export const validWorkflow = async ()=>{
    throw new Error("You attempted to execute workflow validWorkflow function directly. To start a workflow, use start(validWorkflow) from workflow/api");
};
validWorkflow.workflowId = "workflow//input.js//validWorkflow";
registerStepFunction("step//input.js//validStep", validStep);
