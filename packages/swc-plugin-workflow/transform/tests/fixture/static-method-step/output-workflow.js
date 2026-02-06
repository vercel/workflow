import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//MyService.process":{"name":"MyService.process","source":"input.js"},"step//./input//MyService.transform":{"name":"MyService.transform","source":"input.js"}},"classes":{"class//./input//MyService":{"name":"MyService","source":"input.js"}}}*/;
export class MyService {
    // Regular static method (no directive)
    static regularMethod() {
        return 'regular';
    }
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.process");
MyService.transform = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.transform");
registerSerializationClass("class//./input//MyService", MyService);
