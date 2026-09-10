// Class expressions with "use step" methods must be registered through the
// binding that is in scope at module level. Bundlers emit several shapes for
// `class Foo {}` and all of them must resolve to the assigned binding rather
// than falling back to a placeholder name that does not exist at runtime.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Alpha#run":{"stepId":"step//./input//Alpha#run"},"Beta#run":{"stepId":"step//./input//Beta#run"},"Delta#run":{"stepId":"step//./input//Delta#run"},"Epsilon.make":{"stepId":"step//./input//Epsilon.make"},"FileSystem#readFile":{"stepId":"step//./input//FileSystem#readFile"},"Gamma#run":{"stepId":"step//./input//Gamma#run"},"Job.execute":{"stepId":"step//./input//Job.execute"},"Plugin#run":{"stepId":"step//./input//Plugin#run"},"Zeta#run":{"stepId":"step//./input//Zeta#run"},"kebab-job#status":{"stepId":"step//./input//kebab-job#status"}}},"classes":{"input.js":{"Alpha":{"classId":"class//./input//Alpha"},"Beta":{"classId":"class//./input//Beta"},"Delta":{"classId":"class//./input//Delta"},"Epsilon":{"classId":"class//./input//Epsilon"},"FileSystem":{"classId":"class//./input//FileSystem"},"Gamma":{"classId":"class//./input//Gamma"},"Job":{"classId":"class//./input//Job"},"Plugin":{"classId":"class//./input//Plugin"},"Unreferenced":{"classId":"class//./input//Unreferenced"},"Zeta":{"classId":"class//./input//Zeta"},"kebab-job":{"classId":"class//./input//kebab-job"}}}}*/;
// tsdown/rolldown and esbuild emit this for classes that do not self-reference
// (this is the shape shipped by @vercel/sandbox, see vercel/workflow#3929).
var FileSystem = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["readFile"];
    __wf_reg.set("step//./input//FileSystem#readFile", __wf_fn);
    __wf_fn.stepId = "step//./input//FileSystem#readFile";
    Object.defineProperty(__wf_fn, "name", {
        value: "readFile",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//FileSystem", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//FileSystem",
        writable: false,
        enumerable: false,
        configurable: false
    });
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
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Alpha#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Alpha#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Alpha", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Alpha",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Alpha {
    async run() {
        return 'alpha';
    }
}), Beta = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Beta#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Beta#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Beta", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Beta",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Beta {
    async run() {
        return 'beta';
    }
});
// Deferred assignment to a module-level binding.
let Gamma;
Gamma = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Gamma#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Gamma#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Gamma", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Gamma",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Gamma {
    async run() {
        return 'gamma';
    }
});
// Parenthesized initializer.
var Delta = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Delta#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Delta#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Delta", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Delta",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Delta {
    async run() {
        return 'delta';
    }
});
// Assignment chain (Babel CJS interop emits `var X = exports.X = class {}`).
var Epsilon = exports.Epsilon = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.make;
    __wf_reg.set("step//./input//Epsilon.make", __wf_fn);
    __wf_fn.stepId = "step//./input//Epsilon.make";
    Object.defineProperty(__wf_fn, "name", {
        value: "make",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Epsilon", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Epsilon",
        writable: false,
        enumerable: false,
        configurable: false
    });
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
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Zeta#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Zeta#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Zeta", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Zeta",
        writable: false,
        enumerable: false,
        configurable: false
    });
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
        var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
        __wf_fn = __wf_cls.execute;
        __wf_reg.set("step//./input//Job.execute", __wf_fn);
        __wf_fn.stepId = "step//./input//Job.execute";
        Object.defineProperty(__wf_fn, "name", {
            value: "execute",
            configurable: true
        });
        var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
        __wf_cls_reg.set("class//./input//Job", __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: "class//./input//Job",
            writable: false,
            enumerable: false,
            configurable: false
        });
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
        var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
        __wf_fn = Object.getOwnPropertyDescriptor(__wf_cls.prototype, "status").get;
        __wf_reg.set("step//./input//kebab-job#status", __wf_fn);
        __wf_fn.stepId = "step//./input//kebab-job#status";
        Object.defineProperty(__wf_fn, "name", {
            value: "status",
            configurable: true
        });
        var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
        __wf_cls_reg.set("class//./input//kebab-job", __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: "class//./input//kebab-job",
            writable: false,
            enumerable: false,
            configurable: false
        });
        return __wf_cls;
    }(class {
        get status() {
            return 'ok';
        }
    })
};
// A binding that nothing else references is still kept: evaluating the
// initializer is what registers the class.
const Unreferenced = function(__wf_cls) {
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Unreferenced", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Unreferenced",
        writable: false,
        enumerable: false,
        configurable: false
    });
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
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//Plugin#run", __wf_fn);
    __wf_fn.stepId = "step//./input//Plugin#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Plugin", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Plugin",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Plugin {
    async run() {
        return 'plugin';
    }
}));
export { FileSystem, Alpha, Beta, Gamma, Delta, Epsilon };
