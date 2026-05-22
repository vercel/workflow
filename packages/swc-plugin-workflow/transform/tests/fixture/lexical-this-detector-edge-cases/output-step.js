import { registerStepFunction } from "workflow/internal/private";
// Edge cases for the lexical-`this` detector that drives `.bind(this)` and
// the arrow→function hoisting choice.
//
//   - default parameter initializers see lexical `this` ⇒ should bind
//   - destructuring parameter defaults see lexical `this` ⇒ should bind
//   - class field initializers / methods inside the arrow body bind their own
//     `this` (the class instance), so they should NOT trigger the detector
//   - `extends` clauses and computed property keys inside such a class are
//     evaluated in the outer scope, so `this` references there SHOULD trigger
//     the detector.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"}}},"classes":{"input.js":{"Edge":{"classId":"class//./input//Edge"}}}}*/;
async function _anonymousStep0(input = this.value) {
    return input + 1;
}
var _anonymousStep1 = async ()=>{
    class Inner {
        self = this;
        getThis() {
            return this;
        }
    }
    return new Inner();
};
export class Edge {
    static [WORKFLOW_SERIALIZE](inst) {
        return {
            value: inst.value
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Edge(data.value);
    }
    constructor(value){
        this.value = value;
    }
    // `this` appears only in a default parameter (no body reference).
    // Detector should still flag this and emit `.bind(this)`.
    withThisInDefaultParam() {
        return {
            execute: async (input = this.value)=>{
                return input + 1;
            }
        };
    }
    // `this` appears only inside a class body declared *inside* the arrow.
    // The class field initializer's `this` is the new instance, NOT the
    // outer arrow's lexical `this`. Detector should NOT flag this.
    withClassBodyOnly() {
        return {
            execute: async ()=>{
                class Inner {
                    self = this;
                    getThis() {
                        return this;
                    }
                }
                return new Inner();
            }
        };
    }
}
registerStepFunction("step//./input//_anonymousStep0", _anonymousStep0);
registerStepFunction("step//./input//_anonymousStep1", _anonymousStep1);
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Edge, "class//./input//Edge");
