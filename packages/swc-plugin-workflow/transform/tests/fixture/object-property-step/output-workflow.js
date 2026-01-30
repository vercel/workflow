import * as z from 'zod';
import { tool } from 'ai';
/**__internal_workflows{"steps":{"input.js":{"timeTool/execute":{"stepId":"step//./input//timeTool/execute"},"weatherTool/execute":{"stepId":"step//./input//weatherTool/execute"},"weatherTool2/execute":{"stepId":"step//./input//weatherTool2/execute"}}}}*/;
export const weatherTool = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//weatherTool/execute")
});
export const timeTool = tool({
    description: 'Get the current time',
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//timeTool/execute")
});
export const weatherTool2 = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//weatherTool2/execute")
});
