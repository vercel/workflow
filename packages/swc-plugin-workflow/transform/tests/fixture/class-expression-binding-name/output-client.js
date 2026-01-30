import { registerSerializationClass } from "workflow/internal/class-serialization";
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
var Shell = class {
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
registerSerializationClass("class//./input//Bash", Bash);
registerSerializationClass("class//./input//Shell", Shell);
