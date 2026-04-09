/**__internal_workflows{"steps":{"input.js":{"processData":{"stepId":"step//./input//processData"}}}}*/;
// Default export of sync function should be allowed in "use step" files
export default function processData(input) {
    return input * 2;
}
processData.stepId = "step//./input//processData";
