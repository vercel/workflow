/**__internal_workflows{"steps":{"input.js":{"Alpha#run":{"stepId":"step//./input//Alpha#run"},"Beta#run":{"stepId":"step//./input//Beta#run"},"Delta#run":{"stepId":"step//./input//Delta#run"},"Epsilon.make":{"stepId":"step//./input//Epsilon.make"},"FileSystem#readFile":{"stepId":"step//./input//FileSystem#readFile"},"Gamma#run":{"stepId":"step//./input//Gamma#run"},"Job.execute":{"stepId":"step//./input//Job.execute"},"Plugin#run":{"stepId":"step//./input//Plugin#run"},"Zeta#run":{"stepId":"step//./input//Zeta#run"},"kebab-job#status":{"stepId":"step//./input//kebab-job#status"}}},"classes":{"input.js":{"Alpha":{"classId":"class//./input//Alpha"},"Beta":{"classId":"class//./input//Beta"},"Delta":{"classId":"class//./input//Delta"},"Epsilon":{"classId":"class//./input//Epsilon"},"FileSystem":{"classId":"class//./input//FileSystem"},"Gamma":{"classId":"class//./input//Gamma"},"Job":{"classId":"class//./input//Job"},"Plugin":{"classId":"class//./input//Plugin"},"Zeta":{"classId":"class//./input//Zeta"},"kebab-job":{"classId":"class//./input//kebab-job"}}}}*/;
// Class expressions with "use step" methods must be registered through the
// binding that is in scope at module level. Bundlers emit several shapes for
// `class Foo {}` and all of them must resolve to the assigned binding rather
// than falling back to a placeholder name that does not exist at runtime.
// tsdown/rolldown and esbuild emit this for classes that do not self-reference
// (this is the shape shipped by @vercel/sandbox, see vercel/workflow#3929).
var FileSystem = function(__wf_cls) {
    __wf_cls.prototype["readFile"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//FileSystem#readFile");
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
});
// Multiple declarators in one statement: each class must get its own binding.
var Alpha = function(__wf_cls) {
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Alpha#run");
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
}), Beta = function(__wf_cls) {
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Beta#run");
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
});
// Deferred assignment to a module-level binding.
let Gamma;
Gamma = function(__wf_cls) {
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Gamma#run");
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
});
// Parenthesized initializer.
var Delta = function(__wf_cls) {
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Delta#run");
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
});
// Assignment chain (Babel CJS interop emits `var X = exports.X = class {}`).
var Epsilon = exports.Epsilon = function(__wf_cls) {
    __wf_cls.make = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Epsilon.make");
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
});
exports.Zeta = function(__wf_cls) {
    Object.defineProperty(__wf_cls, "name", {
        value: "Zeta",
        configurable: true
    });
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Zeta#run");
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
});
// Object literal property value: the key is the name, with `.name` preserved.
export const handlers = {
    Job: function(__wf_cls) {
        Object.defineProperty(__wf_cls, "name", {
            value: "Job",
            configurable: true
        });
        __wf_cls.execute = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Job.execute");
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
    }),
    'kebab-job': function(__wf_cls) {
        Object.defineProperty(__wf_cls, "name", {
            value: "kebab-job",
            configurable: true
        });
        var __step_kebab_job$status = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//kebab-job#status");
        Object.defineProperty(__wf_cls.prototype, "status", {
            get () {
                return __step_kebab_job$status.call(this);
            },
            configurable: true,
            enumerable: false
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
    })
};
// Named class expression in an arbitrary position: its own name is used.
registerPlugin(function(__wf_cls) {
    __wf_cls.prototype["run"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Plugin#run");
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
}));
export { FileSystem, Alpha, Beta, Gamma, Delta, Epsilon };
