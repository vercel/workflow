import { usefulHelper// do not remove
 } from './utils';
import * as useful from './useful'; // do not remove
/**__internal_workflows{"steps":{"input.js":{"processData":{"stepId":"step//./input//processData"}}}}*/;
export async function processData(data) {
    const result = someHelper(data);
    const transformed = anotherHelper(result);
    localFunction();
    return defaultExport(transformed);
}
export function normalFunction() {
    // since this function is exported we can't remove it
    useful.doSomething();
    return usefulHelper();
}
