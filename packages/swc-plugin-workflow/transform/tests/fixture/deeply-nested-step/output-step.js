import { registerStepFunction } from "workflow/internal/private";
import { createConfig } from "some-library";
/**__internal_workflows{"steps":{"input.js":{"config/level1/level2/level3/myStep":{"stepId":"step//./input//config/level1/level2/level3/myStep"}}}}*/;
var config$level1$level2$level3$myStep = async function(input) {
    return input * 2;
};
// Test deeply nested step functions (4 levels deep)
export const config = createConfig({
    level1: {
        level2: {
            level3: {
                myStep: config$level1$level2$level3$myStep
            }
        }
    }
});
registerStepFunction("step//./input//config/level1/level2/level3/myStep", config$level1$level2$level3$myStep);
