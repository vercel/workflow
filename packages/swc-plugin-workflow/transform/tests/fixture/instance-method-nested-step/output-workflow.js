import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"input.js":{"Service#process":{"stepId":"step//input.js//Service#process"}}}}*/;
export class Service {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            value: instance.value
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Service(data.value);
    }
    constructor(value){
        this.value = value;
    }
}
Service.prototype.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//Service#process");
registerSerializationClass("class//input.js//Service", Service);
