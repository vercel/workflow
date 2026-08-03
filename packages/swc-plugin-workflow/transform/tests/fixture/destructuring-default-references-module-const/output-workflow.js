/**__internal_workflows{"steps":{"input.js":{"s":{"stepId":"step//./input//s"}}}}*/;
// Regression test for issue #2396: dead-code elimination must not strip a
// module-scope declaration that is referenced only by a destructuring-default
// initializer (e.g. `const { ttl = TTL } = options;`). The reference lives
// inside the binding pattern, which the usage collector previously skipped,
// so the declaration was pruned and the surviving code threw a runtime
// ReferenceError when the default fired.
//
// Both consts below are referenced ONLY through destructuring defaults and
// must survive in both step and workflow mode.
// Referenced from a destructuring default inside a class static method.
const TTL = 1000;
// Referenced from a destructuring default inside a plain top-level function,
// to prove the bug is class-independent.
const RETRIES = 3;
var s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//s");
export class C {
    static make(options = {}) {
        const { ttl = TTL } = options;
        return ttl;
    }
}
export function plain(options = {}) {
    const { retries = RETRIES } = options;
    return retries;
}
