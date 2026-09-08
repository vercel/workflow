import { registerStepFunction } from "workflow/internal/private";
// Class expressions with "use step" methods must be registered through the
// binding that is in scope at module level. Bundlers emit several shapes for
// `class Foo {}` and all of them must resolve to the assigned binding rather
// than falling back to a placeholder name that does not exist at runtime.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Alpha#run":{"stepId":"step//./input//Alpha#run"},"Beta#run":{"stepId":"step//./input//Beta#run"},"Delta#run":{"stepId":"step//./input//Delta#run"},"Epsilon.make":{"stepId":"step//./input//Epsilon.make"},"FileSystem#readFile":{"stepId":"step//./input//FileSystem#readFile"},"Gamma#run":{"stepId":"step//./input//Gamma#run"},"Job.execute":{"stepId":"step//./input//Job.execute"},"Plugin#run":{"stepId":"step//./input//Plugin#run"},"Zeta#run":{"stepId":"step//./input//Zeta#run"},"kebab-job#status":{"stepId":"step//./input//kebab-job#status"}}},"classes":{"input.js":{"Alpha":{"classId":"class//./input//Alpha"},"Beta":{"classId":"class//./input//Beta"},"Delta":{"classId":"class//./input//Delta"},"Epsilon":{"classId":"class//./input//Epsilon"},"FileSystem":{"classId":"class//./input//FileSystem"},"Gamma":{"classId":"class//./input//Gamma"},"Job":{"classId":"class//./input//Job"},"Plugin":{"classId":"class//./input//Plugin"},"Unreferenced":{"classId":"class//./input//Unreferenced"},"Zeta":{"classId":"class//./input//Zeta"},"kebab-job":{"classId":"class//./input//kebab-job"}}}}*/;
// tsdown/rolldown and esbuild emit this for classes that do not self-reference
// (this is the shape shipped by @vercel/sandbox, see vercel/workflow#3929).
var FileSystem = function(__wf_cls) {
    registerStepFunction("step//./input//FileSystem#readFile", __wf_cls.prototype["readFile"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//FileSystem");
    return __wf_cls;
}(class FileSystem {
    constructor(sandbox){
        this.sandbox = sandbox;
    }
    async readFile(path) {
        return this.sandbox.read(path);
    }
});
// Multiple declarators in one statement: each class must get its own binding.
var Alpha = function(__wf_cls) {
    registerStepFunction("step//./input//Alpha#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Alpha");
    return __wf_cls;
}(class Alpha {
    async run() {
        return 'alpha';
    }
}), Beta = function(__wf_cls) {
    registerStepFunction("step//./input//Beta#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Beta");
    return __wf_cls;
}(class Beta {
    async run() {
        return 'beta';
    }
});
// Deferred assignment to a module-level binding.
let Gamma;
Gamma = function(__wf_cls) {
    registerStepFunction("step//./input//Gamma#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Gamma");
    return __wf_cls;
}(class Gamma {
    async run() {
        return 'gamma';
    }
});
// Parenthesized initializer.
var Delta = function(__wf_cls) {
    registerStepFunction("step//./input//Delta#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Delta");
    return __wf_cls;
}(class Delta {
    async run() {
        return 'delta';
    }
});
// Assignment chain (Babel CJS interop emits `var X = exports.X = class {}`).
var Epsilon = exports.Epsilon = function(__wf_cls) {
    registerStepFunction("step//./input//Epsilon.make", __wf_cls.make);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Epsilon");
    return __wf_cls;
}(class Epsilon {
    static async make() {
        return new Epsilon();
    }
});
// Assigned to a property: the property name is used for IDs but is not
// introduced as a binding (the class body's `Zeta` refers to the outer one).
const Zeta = 'outer';
exports.Zeta = function(__wf_cls) {
    Object.defineProperty(__wf_cls, "name", {
        value: "Zeta",
        configurable: true
    });
    registerStepFunction("step//./input//Zeta#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Zeta");
    return __wf_cls;
}(class {
    async run() {
        return Zeta;
    }
});
// Object literal property value: the key is the name, with `.name` preserved.
export const handlers = {
    Job: function(__wf_cls) {
        Object.defineProperty(__wf_cls, "name", {
            value: "Job",
            configurable: true
        });
        registerStepFunction("step//./input//Job.execute", __wf_cls.execute);
        (function(__wf_cls, __wf_id) {
            var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
            __wf_reg.set(__wf_id, __wf_cls);
            Object.defineProperty(__wf_cls, "classId", {
                value: __wf_id,
                writable: false,
                enumerable: false,
                configurable: false
            });
        })(__wf_cls, "class//./input//Job");
        return __wf_cls;
    }(class {
        static async execute() {
            return 'job';
        }
    }),
    'kebab-job': function(__wf_cls) {
        Object.defineProperty(__wf_cls, "name", {
            value: "kebab-job",
            configurable: true
        });
        registerStepFunction("step//./input//kebab-job#status", __wf_cls.prototype["status"]);
        (function(__wf_cls, __wf_id) {
            var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
            __wf_reg.set(__wf_id, __wf_cls);
            Object.defineProperty(__wf_cls, "classId", {
                value: __wf_id,
                writable: false,
                enumerable: false,
                configurable: false
            });
        })(__wf_cls, "class//./input//kebab-job");
        return __wf_cls;
    }(class {
        async status() {
            return 'ok';
        }
    })
};
// A binding that nothing else references is still kept: evaluating the
// initializer is what registers the class.
const Unreferenced = function(__wf_cls) {
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Unreferenced");
    return __wf_cls;
}(class Unreferenced {
    static [WORKFLOW_SERIALIZE](inst) {
        return {
            v: inst.v
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return {
            v: data.v
        };
    }
});
// Named class expression in an arbitrary position: its own name is used.
registerPlugin(function(__wf_cls) {
    registerStepFunction("step//./input//Plugin#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//Plugin");
    return __wf_cls;
}(class Plugin {
    async run() {
        return 'plugin';
    }
}));
export { FileSystem, Alpha, Beta, Gamma, Delta, Epsilon };
