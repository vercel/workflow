import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"classes":{"input.js":{"Sandbox":{"classId":"class//./input//Sandbox"}}}}*/;
// Test custom serialization with CommonJS destructured require
const { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } = require("@workflow/serde");
class Sandbox {
    constructor(sandbox, routes){
        this.sandbox = sandbox;
        this.routes = routes;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            sandbox: instance.sandbox,
            routes: instance.routes
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        const instance = Object.create(Sandbox.prototype);
        instance.sandbox = data.sandbox;
        instance.routes = data.routes;
        return instance;
    }
}
exports.Sandbox = Sandbox;
registerSerializationClass("class//./input//Sandbox", Sandbox);
