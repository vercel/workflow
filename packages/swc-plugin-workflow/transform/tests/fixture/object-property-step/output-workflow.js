import * as z from 'zod';
import { tool } from 'ai';
/**__internal_workflows{"steps":{"step//./input//timeTool/execute":{"name":"timeTool/execute","source":"input.js"},"step//./input//weatherTool/execute":{"name":"weatherTool/execute","source":"input.js"},"step//./input//weatherTool2/execute":{"name":"weatherTool2/execute","source":"input.js"}}}*/;
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
