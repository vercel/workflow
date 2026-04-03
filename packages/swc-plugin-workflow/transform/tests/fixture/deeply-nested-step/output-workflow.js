import { createConfig } from "some-library";
/**__internal_workflows{"steps":{"input.js":{"config/level1/level2/level3/myStep":{"stepId":"step//./input//config/level1/level2/level3/myStep"}}}}*/;
// Test deeply nested step functions (4 levels deep)
export const config = createConfig({
    level1: {
        level2: {
            level3: {
                myStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//config/level1/level2/level3/myStep")
            }
        }
    }
});
