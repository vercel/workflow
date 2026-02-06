import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"step//./input//Service#process":{"name":"Service#process","source":"input.js"},"step//./input//helper":{"name":"helper","source":"input.js"}},"classes":{"class//./input//Service":{"name":"Service","source":"input.js"}}}*/;
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
        const helper = async (x)=>{
            return x * 2;
        };
        const doubled = await helper(input);
        return doubled + this.value;
    }
}
registerSerializationClass("class//./input//Service", Service);
