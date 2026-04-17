import * as z from 'zod';
import { tool } from 'ai';
/**__internal_workflows{"steps":{"input.js":{"timeTool/execute":{"stepId":"step//./input//timeTool/execute"},"weatherTool/execute":{"stepId":"step//./input//weatherTool/execute"},"weatherTool2/execute":{"stepId":"step//./input//weatherTool2/execute"}}}}*/;
var weatherTool$execute = async function({ location }) {
    return {
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "weatherTool$execute",
        configurable: true
    });
})(weatherTool$execute, "step//./input//weatherTool/execute");
var timeTool$execute = async function timeToolImpl() {
    return {
        time: new Date().toISOString()
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "timeTool$execute",
        configurable: true
    });
})(timeTool$execute, "step//./input//timeTool/execute");
var weatherTool2$execute = async function({ location }) {
    return {
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "weatherTool2$execute",
        configurable: true
    });
})(weatherTool2$execute, "step//./input//weatherTool2/execute");
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
