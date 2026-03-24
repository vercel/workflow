import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"},"MyService.transform":{"stepId":"step//./input//MyService.transform"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
    static async process(data) {
        return data.value * 2;
    }
    static async transform(input, factor) {
        return input * factor;
    }
    // Regular static method (no directive)
    static regularMethod() {
        return 'regular';
    }
}
registerStepFunction("step//./input//MyService.process", MyService.process);
registerStepFunction("step//./input//MyService.transform", MyService.transform);
registerSerializationClass("class//./input//MyService", MyService);
