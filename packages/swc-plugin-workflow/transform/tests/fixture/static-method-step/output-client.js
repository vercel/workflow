import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//input.js//MyService.process"},"MyService.transform":{"stepId":"step//input.js//MyService.transform"}}}}*/;
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
registerSerializationClass("class//input.js//MyService", MyService);
