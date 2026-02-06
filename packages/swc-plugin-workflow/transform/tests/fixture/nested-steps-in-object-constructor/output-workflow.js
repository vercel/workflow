import { DurableAgent } from '@workflow/ai/agent';
import { tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"steps":{"step//./input//_anonymousStep0":{"name":"_anonymousStep0","source":"input.js"},"step//./input//_anonymousStep1":{"name":"_anonymousStep1","source":"input.js"}},"workflows":{"workflow//./input//test":{"name":"test","source":"input.js"}}}*/;
export async function test() {
    const agent = new DurableAgent({
        model: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test/_anonymousStep0"),
        tools: {
            getWeather: tool({
                description: 'Get weather for a location',
                inputSchema: z.object({
                    location: z.string()
                }),
                execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test/_anonymousStep1")
            })
        }
    });
    await agent.stream({
        messages: [
            {
                role: 'user',
                content: 'What is the weather in San Francisco?'
            }
        ]
    });
}
test.workflowId = "workflow//./input//test";
globalThis.__private_workflows.set("workflow//./input//test", test);
