// Test class expression where binding name differs from internal class name
// e.g., `var Bash = class _Bash {}` - the registration should use "Bash", not "_Bash"
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"classes":{"input.js":{"Bash":{"classId":"class//./input//Bash"},"Shell":{"classId":"class//./input//Shell"}}}}*/;
// Class expression with different binding name
var Bash = function(__wf_cls) {
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Bash", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Bash",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class _Bash {
    constructor(command){
        this.command = command;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            command: instance.command
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Bash(data.command);
    }
});
// Also test anonymous class expression (no internal name)
var Shell = function(__wf_cls) {
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//Shell", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: "class//./input//Shell",
        writable: false,
        enumerable: false,
        configurable: false
    });
    return __wf_cls;
}(class Shell {
    constructor(cmd){
        this.cmd = cmd;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            cmd: instance.cmd
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Shell(data.cmd);
    }
});
export { Bash, Shell };
