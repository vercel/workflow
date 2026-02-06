import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//MyService.process":{"name":"MyService.process","source":"input.js"},"step//./input//MyService.transform":{"name":"MyService.transform","source":"input.js"}},"classes":{"class//./input//MyService":{"name":"MyService","source":"input.js"}}}*/;
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
