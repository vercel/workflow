// Error: Can't have both directives in the same file
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//test":{"name":"test","source":"input.js"}}}*/;
'use workflow';
export async function test() {
    return 42;
}
registerStepFunction("step//./input//test", test);
