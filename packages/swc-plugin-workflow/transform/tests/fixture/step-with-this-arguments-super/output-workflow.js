import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//./input//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//./input//stepWithArguments"},"stepWithThis":{"stepId":"step//./input//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithThis");
export var stepWithArguments = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithArguments");
class TestClass extends BaseClass {
}
TestClass.prototype["stepMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass#stepMethod");
registerSerializationClass("class//./input//TestClass", TestClass);
