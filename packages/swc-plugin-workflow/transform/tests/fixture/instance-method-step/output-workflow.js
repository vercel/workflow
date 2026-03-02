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
}
Calculator.prototype["multiply"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#multiply");
Calculator.prototype["add"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#add");
registerSerializationClass("class//./input//Calculator", Calculator);
