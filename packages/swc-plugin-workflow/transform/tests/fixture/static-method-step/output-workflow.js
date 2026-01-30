import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"},"MyService.transform":{"stepId":"step//./input//MyService.transform"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
    // Regular static method (no directive)
    static regularMethod() {
        return 'regular';
    }
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.process");
MyService.transform = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.transform");
registerSerializationClass("class//./input//MyService", MyService);
