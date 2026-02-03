import { agent } from "experimental-agent";
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: async (input, { experimental_context })=>{
                return 1 + 1;
            }
        }
    }
});
