import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"workflows":{"my-package":{"myWorkflow":{"workflowId":"workflow//my-package//myWorkflow"}}},"steps":{"my-package":{"myStep":{"stepId":"step//my-package//myStep"}}},"classes":{"my-package":{"MyClass":{"classId":"class//my-package//MyClass"}}}}*/;
// Tests that when package_path is provided, IDs use the package specifier
// instead of the filename. This ensures stable IDs across export conditions.
const serialize = Symbol.for("workflow-serialize");
const deserialize = Symbol.for("workflow-deserialize");
export class MyClass {
    value;
    constructor(value){
        this.value = value;
    }
    static [serialize](instance) {
        return {
            value: instance.value
        };
    }
    static [deserialize](data) {
        return new MyClass(data.value);
    }
}
export async function myWorkflow() {
    return "hello";
}
myWorkflow.workflowId = "workflow//my-package//myWorkflow";
globalThis.__private_workflows.set("workflow//my-package//myWorkflow", myWorkflow);
export var myStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//my-package//myStep");
registerSerializationClass("class//my-package//MyClass", MyClass);
