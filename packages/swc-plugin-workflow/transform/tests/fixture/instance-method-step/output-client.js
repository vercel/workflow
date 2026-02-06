import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"step//./input//Calculator#add":{"name":"Calculator#add","source":"input.js"},"step//./input//Calculator#multiply":{"name":"Calculator#multiply","source":"input.js"}},"classes":{"class//./input//Calculator":{"name":"Calculator","source":"input.js"}}}*/;
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
