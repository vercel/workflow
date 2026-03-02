import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//./input//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//./input//stepWithArguments"},"stepWithThis":{"stepId":"step//./input//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export async function stepWithThis() {
    // `this` is allowed in step functions
    return this.value;
}
stepWithThis.stepId = "step//./input//stepWithThis";
export async function stepWithArguments() {
    // `arguments` is allowed in step functions
    return arguments[0];
}
stepWithArguments.stepId = "step//./input//stepWithArguments";
class TestClass extends BaseClass {
    async stepMethod() {
        // `super` is allowed in step functions
        return super.method();
    }
}
registerSerializationClass("class//./input//TestClass", TestClass);
