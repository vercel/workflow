import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"stepWithArguments":{"stepId":"step//input.js//stepWithArguments"},"stepWithThis":{"stepId":"step//input.js//stepWithThis"}}}}*/;
export async function stepWithThis() {
    // Error: this is not allowed
    return this.value;
}
export async function stepWithArguments() {
    // Error: arguments is not allowed
    return arguments[0];
}
class TestClass extends BaseClass {
    async stepMethod() {
        'use step';
        // Error: super is not allowed
        return super.method();
    }
}
registerStepFunction("step//input.js//stepWithThis", stepWithThis);
registerStepFunction("step//input.js//stepWithArguments", stepWithArguments);
