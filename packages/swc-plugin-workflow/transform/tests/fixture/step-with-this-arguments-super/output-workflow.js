import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//input.js//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//input.js//stepWithArguments"},"stepWithThis":{"stepId":"step//input.js//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//input.js//TestClass"}}}}*/;
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWithThis");
export var stepWithArguments = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWithArguments");
class TestClass extends BaseClass {
}
TestClass.prototype["stepMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//TestClass#stepMethod");
registerSerializationClass("class//input.js//TestClass", TestClass);
