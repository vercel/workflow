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
}
Calculator.prototype["multiply"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#multiply");
Calculator.prototype["add"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#add");
registerSerializationClass("class//./input//Calculator", Calculator);
