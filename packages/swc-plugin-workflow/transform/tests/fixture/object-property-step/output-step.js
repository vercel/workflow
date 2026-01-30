import { registerStepFunction } from "workflow/internal/private";
import * as z from 'zod';
import { tool } from 'ai';
/**__internal_workflows{"steps":{"input.js":{"timeTool/execute":{"stepId":"step//./input//timeTool/execute"},"weatherTool/execute":{"stepId":"step//./input//weatherTool/execute"},"weatherTool2/execute":{"stepId":"step//./input//weatherTool2/execute"}}}}*/;
var weatherTool$execute = async ({ location })=>{
    return {
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10
    };
};
var timeTool$execute = async ()=>{
    return {
        time: new Date().toISOString()
    };
};
var weatherTool2$execute = async ({ location })=>{
    return {
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10
    };
};
export const weatherTool = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: weatherTool$execute
});
export const timeTool = tool({
    description: 'Get the current time',
    execute: timeTool$execute
});
export const weatherTool2 = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for')
    }),
    execute: weatherTool2$execute
});
registerStepFunction("step//./input//weatherTool/execute", weatherTool$execute);
registerStepFunction("step//./input//timeTool/execute", timeTool$execute);
registerStepFunction("step//./input//weatherTool2/execute", weatherTool2$execute);
