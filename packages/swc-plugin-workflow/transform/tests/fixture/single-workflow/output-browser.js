import { __browserWorkflowClient } from "@workflow/world-browser/client";
/**__internal_workflows{"workflows":{"input.js":{"workflow":{"workflowId":"workflow//input.js//workflow"}}}}*/;
export async function workflow(a, b) {
    return __browserWorkflowClient.run("workflow//input.js//workflow", [
        a,
        b
    ]);
}
workflow.workflowId = "workflow//input.js//workflow";
