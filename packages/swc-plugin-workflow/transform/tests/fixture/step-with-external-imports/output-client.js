import { getPackageJson } from "./helper";
import { formatOutput } from "./utils";
/**__internal_workflows{"steps":{"input.js":{"myOtherStep":{"stepId":"step//./input//myOtherStep"},"myStep":{"stepId":"step//./input//myStep"}}}}*/;
export async function myStep() {
    return await getPackageJson();
}
myStep.stepId = "step//./input//myStep";
export async function myOtherStep(data) {
    return formatOutput(data);
}
myOtherStep.stepId = "step//./input//myOtherStep";
