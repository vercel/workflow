import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//validStep":{"name":"validStep","source":"input.js"}}}*/;
// These should all error - only async functions allowed
export const value = 42;
export function syncFunc() {
    return 'not allowed';
}
export class MyClass {
    method() {}
}
export * from './other';
// This is ok
export async function validStep() {
    return 'allowed';
}
registerStepFunction("step//./input//validStep", validStep);
