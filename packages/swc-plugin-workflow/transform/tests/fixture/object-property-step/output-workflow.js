import * as z from 'zod';
import { tool } from 'ai';
/**__internal_workflows{"steps":{"input.js":{"timeTool/execute":{"stepId":"step//input.js//timeTool/execute"},"weatherTool/execute":{"stepId":"step//input.js//weatherTool/execute"},"weatherTool2/execute":{"stepId":"step//input.js//weatherTool2/execute"}}}}*/;
export const weatherTool = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//weatherTool/execute")
});
export const timeTool = tool({
    description: 'Get the current time',
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//timeTool/execute")
});
export const weatherTool2 = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//weatherTool2/execute")
});
