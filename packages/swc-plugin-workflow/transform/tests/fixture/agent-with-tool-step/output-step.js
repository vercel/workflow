import { registerStepFunction } from "workflow/internal/private";
import { agent } from "experimental-agent";
var vade$tools$VercelRequest$execute = async function(input, { experimental_context }) {
    return 1 + 1;
};
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: async (input, { experimental_context })=>{
                return 1 + 1;
            }
        }
    }
});
registerStepFunction("step//./input//vade/tools/VercelRequest/execute", vade$tools$VercelRequest$execute);
