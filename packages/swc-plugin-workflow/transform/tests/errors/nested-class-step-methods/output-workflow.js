// Step method and serialization registrations are emitted at module level, so
// a class declared inside a function cannot be referenced by them. The
// compiler used to emit `Inner.prototype[...]` at module scope, which throws a
// ReferenceError at module evaluation. It must instead fail at compile time.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Top#run":{"stepId":"step//./input//Top#run"}}},"classes":{"input.js":{"Top":{"classId":"class//./input//Top"}}}}*/;
// Error: class declaration inside a function
export function makeService() {
    class Service {
        async fetch() {
            'use step';
            return 'data';
        }
    }
    return new Service();
}
// Error: class expression assigned inside a function (this is also the shape
// esbuild produces when it wraps a module in a lazy `__esm` initializer)
var Lazy;
export function init() {
    Lazy = class {
        static async load() {
            'use step';
            return 'lazy';
        }
    };
}
// Error: custom serialization on a nested class
export const factory = ()=>{
    const Point = class {
        static [WORKFLOW_SERIALIZE](inst) {
            return {
                x: inst.x
            };
        }
        static [WORKFLOW_DESERIALIZE](data) {
            return new Point(data.x);
        }
    };
    return Point;
};
// OK: a nested class without steps or serialization
export function helper() {
    class Local {
        value() {
            return 1;
        }
    }
    return new Local();
}
// OK: module-level class declaration
export class Top {
}
Top.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Top#run");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Top, "class//./input//Top");
