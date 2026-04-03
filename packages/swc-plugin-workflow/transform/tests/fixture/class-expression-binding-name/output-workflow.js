// Test class expression where binding name differs from internal class name
// e.g., `var Bash = class _Bash {}` - the registration should use "Bash", not "_Bash"
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"classes":{"input.js":{"Bash":{"classId":"class//./input//Bash"},"Shell":{"classId":"class//./input//Shell"}}}}*/;
// Class expression with different binding name
var Bash = class _Bash {
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
};
// Also test anonymous class expression (no internal name)
var Shell = class Shell {
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
};
export { Bash, Shell };
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Bash, "class//./input//Bash");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Shell, "class//./input//Shell");
