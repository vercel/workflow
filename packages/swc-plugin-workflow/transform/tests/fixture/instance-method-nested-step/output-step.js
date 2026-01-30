import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"input.js":{"Service#process":{"stepId":"step//./input//Service#process"},"helper":{"stepId":"step//./input//helper"}}},"classes":{"input.js":{"Service":{"classId":"class//./input//Service"}}}}*/;
var Service$process$helper = async (x)=>x * 2;
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
    // Instance method step that contains a nested step function
    async process(input) {
        // This nested step should be transformed
        const helper = Service$process$helper;
        const doubled = await helper(input);
        return doubled + this.value;
    }
}
registerStepFunction("step//./input//Service$process/helper", Service$process$helper);
registerStepFunction("step//./input//Service#process", Service.prototype["process"]);
registerSerializationClass("class//./input//Service", Service);
