// Anonymous class expressions in positions that provide no name (not assigned
// to a variable or property) have nothing to derive a step/class ID from. The
// compiler used to emit `AnonymousClass.prototype[...]`, which is a guaranteed
// ReferenceError at module evaluation (vercel/workflow#3929). It must instead
// fail at compile time.
/**__internal_workflows{"steps":{"input.js":{"NamedPlugin#run":{"stepId":"step//./input//NamedPlugin#run"}}},"classes":{"input.js":{"NamedPlugin":{"classId":"class//./input//NamedPlugin"}}}}*/;
// Error: class passed directly as an argument
registerPlugin(class {
    async run() {
        'use step';
        return 'plugin';
    }
});
// Error: class as an array element
export const handlers = [
    class {
        static async execute() {
            'use step';
            return 'job';
        }
    }
];
// Error: class chosen by a conditional
export const Worker = process.env.FAST ? class {
    get status() {
        'use step';
        return 'ok';
    }
} : null;
// Error: static "use workflow" method
useModel(class {
    static async orchestrate() {
        'use workflow';
        return 'done';
    }
});
// OK: anonymous class expression without steps or serialization
export const plain = class {
    greet() {
        return 'hi';
    }
};
// OK: naming the class is all that is needed
registerPlugin(function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["run"];
    __wf_reg.set("step//./input//NamedPlugin#run", __wf_fn);
    __wf_fn.stepId = "step//./input//NamedPlugin#run";
    Object.defineProperty(__wf_fn, "name", {
        value: "run",
        configurable: true
    });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//NamedPlugin", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//NamedPlugin",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class NamedPlugin {
    async run() {
        return 'named';
    }
}));
