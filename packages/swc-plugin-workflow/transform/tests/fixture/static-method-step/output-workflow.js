/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//input.js//MyService.process"},"MyService.transform":{"stepId":"step//input.js//MyService.transform"}}}}*/;
export class MyService {
    // Regular static method (no directive)
    static regularMethod() {
        return 'regular';
    }
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//MyService.process");
MyService.transform = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//MyService.transform");
MyService.classId = "class//input.js//MyService";
