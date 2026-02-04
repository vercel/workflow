import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//vade/tools/VercelRequest/execute")
        }
    }
});
