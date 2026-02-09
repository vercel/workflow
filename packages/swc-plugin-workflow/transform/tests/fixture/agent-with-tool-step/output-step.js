import { registerStepFunction } from "workflow/internal/private";
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
var vade$tools$VercelRequest$execute = async function(input, { experimental_context }) {
    return 1 + 1;
};
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: vade$tools$VercelRequest$execute
        }
    }
});
registerStepFunction("step//./input//vade/tools/VercelRequest/execute", vade$tools$VercelRequest$execute);
