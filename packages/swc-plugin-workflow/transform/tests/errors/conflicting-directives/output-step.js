// Error: Can't have both directives in the same file
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"test":{"stepId":"step//input.js//test"}}}}*/;
'use workflow';
export async function test() {
    return 42;
}
registerStepFunction("step//input.js//test", test);
