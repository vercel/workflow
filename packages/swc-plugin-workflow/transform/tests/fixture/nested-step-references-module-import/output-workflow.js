// Regression test: imports used by a step that gets hoisted out of a
// workflow body must NOT be stripped by dead-code elimination in step
// mode. Imports referenced only by the workflow body (which is replaced
// with a `throw` proxy) and truly unused imports should still be stripped.
import { tool, z } from 'some-agent-lib'; // only used by replaced workflow body, should be stripped
/**__internal_workflows{"workflows":{"input.js":{"w":{"workflowId":"workflow//./input//w"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"}}}}*/;
async function w() {
    const agent = new WorkflowAgent({
        model: 'anthropic/claude-opus-4.5',
        tools: ()=>({
                queryDatabase: tool({
                    description: 'Query the database',
                    inputSchema: z.object({
                        query: z.string()
                    }),
                    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//w/_anonymousStep0")
                })
            })
    });
}
w.workflowId = "workflow//./input//w";
globalThis.__private_workflows.set("workflow//./input//w", w);
