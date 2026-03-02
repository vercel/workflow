import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"testStep":{"stepId":"step//./input//testStep"}}}}*/;
// This is the TypeScript-transformed output of:
// async function testStep() {
//   'use step';
//   using resource = getResource();
//   await doWork(resource);
// }
export async function testStep() {
    const env = {
        stack: [],
        error: void 0,
        hasError: false
    };
    try {
        const resource = env.stack.push({
            value: "test"
        });
        await Promise.resolve(resource);
    } catch (e) {
        env.error = e;
        env.hasError = true;
    } finally{
        env.stack.pop();
    }
}
registerStepFunction("step//./input//testStep", testStep);
