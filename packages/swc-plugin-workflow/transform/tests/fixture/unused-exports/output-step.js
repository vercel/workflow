import { registerStepFunction } from "workflow/internal/private";
import { helper } from './helper';
import { unusedHelper } from './unused-helper';
/**__internal_workflows{"steps":{"input.js":{"processData":{"stepId":"step//./input//processData"}}}}*/;
// This variable is exported but not used anywhere in this file
export const CONFIG = {
    apiKey: 'test-key',
    timeout: 5000
};
// This function is exported but not used in this file
export function formatData(data) {
    return unusedHelper(data);
}
// This step function uses the helper
export async function processData(input) {
    return helper(input);
}
// This is used internally
function internalHelper(value) {
    return value * 2;
}
// This is not used anywhere
function unusedFunction() {
    return internalHelper(10);
}
// This exported function uses the internal helper
export function calculate(x) {
    return internalHelper(x);
}
registerStepFunction("step//./input//processData", processData);
