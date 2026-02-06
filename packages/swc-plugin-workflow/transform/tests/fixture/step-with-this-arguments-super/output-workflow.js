import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//TestClass#stepMethod":{"name":"TestClass#stepMethod","source":"input.js"},"step//./input//stepWithArguments":{"name":"stepWithArguments","source":"input.js"},"step//./input//stepWithThis":{"name":"stepWithThis","source":"input.js"}},"classes":{"class//./input//TestClass":{"name":"TestClass","source":"input.js"}}}*/;
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithThis");
export var stepWithArguments = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithArguments");
class TestClass extends BaseClass {
}
TestClass.prototype["stepMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass#stepMethod");
registerSerializationClass("class//./input//TestClass", TestClass);
