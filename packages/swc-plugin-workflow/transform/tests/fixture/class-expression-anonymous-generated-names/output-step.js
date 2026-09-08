import { registerStepFunction } from "workflow/internal/private";
// Anonymous class expressions in positions that provide no name (not assigned
// to a variable or property) still register through the IIFE; only their IDs
// need a name, so a deterministic `AnonymousClass<N>` is generated. The plugin
// used to emit a placeholder `AnonymousClass.prototype[...]` reference, which
// is a guaranteed ReferenceError at module evaluation (vercel/workflow#3929).
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"workflows":{"input.js":{"AnonymousClass5.orchestrate":{"workflowId":"workflow//./input//AnonymousClass5.orchestrate"}}},"steps":{"input.js":{"AnonymousClass1#run":{"stepId":"step//./input//AnonymousClass1#run"},"AnonymousClass2.execute":{"stepId":"step//./input//AnonymousClass2.execute"},"AnonymousClass3#status":{"stepId":"step//./input//AnonymousClass3#status"},"AnonymousClass6$1#run":{"stepId":"step//./input//AnonymousClass6$1#run"},"NamedPlugin#run":{"stepId":"step//./input//NamedPlugin#run"}}},"classes":{"input.js":{"AnonymousClass1":{"classId":"class//./input//AnonymousClass1"},"AnonymousClass2":{"classId":"class//./input//AnonymousClass2"},"AnonymousClass3":{"classId":"class//./input//AnonymousClass3"},"AnonymousClass4":{"classId":"class//./input//AnonymousClass4"},"AnonymousClass6$1":{"classId":"class//./input//AnonymousClass6$1"},"NamedPlugin":{"classId":"class//./input//NamedPlugin"}}}}*/;
// Not counted: an anonymous class with nothing to register does not shift
// the numbering of the ones that follow.
export const plain = class {
    greet() {
        return 'hi';
    }
};
// AnonymousClass1: class passed directly as an argument
registerPlugin(function(__wf_cls) {
    registerStepFunction("step//./input//AnonymousClass1#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//AnonymousClass1");
    return __wf_cls;
}(class {
    async run() {
        return 'plugin';
    }
}));
// AnonymousClass2: class as an array element (static step)
export const handlers = [
    function(__wf_cls) {
        registerStepFunction("step//./input//AnonymousClass2.execute", __wf_cls.execute);
        (function(__wf_cls, __wf_id) {
            var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
            __wf_reg.set(__wf_id, __wf_cls);
            Object.defineProperty(__wf_cls, "classId", {
                value: __wf_id,
                writable: false,
                enumerable: false,
                configurable: false
            });
        })(__wf_cls, "class//./input//AnonymousClass2");
        return __wf_cls;
    }(class {
        static async execute() {
            return 'job';
        }
    })
];
// AnonymousClass3: class chosen by a conditional
export const Worker = process.env.FAST ? function(__wf_cls) {
    registerStepFunction("step//./input//AnonymousClass3#status", __wf_cls.prototype["status"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//AnonymousClass3");
    return __wf_cls;
}(class {
    async status() {
        return 'ok';
    }
}) : null;
// AnonymousClass4: custom serialization only
const registry = new Map([
    [
        'point',
        function(__wf_cls) {
            (function(__wf_cls, __wf_id) {
                var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
                __wf_reg.set(__wf_id, __wf_cls);
                Object.defineProperty(__wf_cls, "classId", {
                    value: __wf_id,
                    writable: false,
                    enumerable: false,
                    configurable: false
                });
            })(__wf_cls, "class//./input//AnonymousClass4");
            return __wf_cls;
        }(class {
            static [WORKFLOW_SERIALIZE](inst) {
                return {
                    x: inst.x
                };
            }
            static [WORKFLOW_DESERIALIZE](data) {
                return {
                    x: data.x
                };
            }
        })
    ]
]);
// AnonymousClass5: static "use workflow" method
useModel(function(__wf_cls) {
    __wf_cls.orchestrate.workflowId = "workflow//./input//AnonymousClass5.orchestrate";
    return __wf_cls;
}(class {
    static async orchestrate() {
        throw new Error("You attempted to execute workflow AnonymousClass5.orchestrate function directly. To start a workflow, use start(workflow) from workflow/api");
    }
}));
// Generated names avoid identifiers already declared in the module.
const AnonymousClass6 = 'taken';
useModel(function(__wf_cls) {
    registerStepFunction("step//./input//AnonymousClass6$1#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//AnonymousClass6$1");
    return __wf_cls;
}(class {
    async run() {
        return 'six';
    }
}));
// A named class expression in the same position keeps its own name.
registerPlugin(function(__wf_cls) {
    registerStepFunction("step//./input//NamedPlugin#run", __wf_cls.prototype["run"]);
    (function(__wf_cls, __wf_id) {
        var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        __wf_reg.set(__wf_id, __wf_cls);
        Object.defineProperty(__wf_cls, "classId", {
            value: __wf_id,
            writable: false,
            enumerable: false,
            configurable: false
        });
    })(__wf_cls, "class//./input//NamedPlugin");
    return __wf_cls;
}(class NamedPlugin {
    async run() {
        return 'named';
    }
}));
