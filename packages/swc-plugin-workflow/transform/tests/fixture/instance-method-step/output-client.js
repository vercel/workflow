import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"input.js":{"Calculator#add":{"stepId":"step//./input//Calculator#add"},"Calculator#multiply":{"stepId":"step//./input//Calculator#multiply"}}},"classes":{"input.js":{"Calculator":{"classId":"class//./input//Calculator"}}}}*/;
export class Calculator {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            multiplier: instance.multiplier
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Calculator(data.multiplier);
    }
    constructor(multiplier){
        this.multiplier = multiplier;
    }
    async multiply(value) {
        return value * this.multiplier;
    }
    async add(a, b) {
        return a + b + this.multiplier;
    }
}
registerSerializationClass("class//./input//Calculator", Calculator);
