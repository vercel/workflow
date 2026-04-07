// Test custom serialization with imported symbols from '@workflow/serde'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"classes":{"input.js":{"Color":{"classId":"class//./input//Color"},"Vector":{"classId":"class//./input//Vector"}}}}*/;
// Class using imported symbols
export class Vector {
    constructor(x, y, z){
        this.x = x;
        this.y = y;
        this.z = z;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            x: instance.x,
            y: instance.y,
            z: instance.z
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Vector(data.x, data.y, data.z);
    }
}
// Class using renamed imports
import { WORKFLOW_SERIALIZE as WS, WORKFLOW_DESERIALIZE as WD } from '@workflow/serde';
export class Color {
    constructor(r, g, b){
        this.r = r;
        this.g = g;
        this.b = b;
    }
    static [WS](instance) {
        return {
            r: instance.r,
            g: instance.g,
            b: instance.b
        };
    }
    static [WD](data) {
        return new Color(data.r, data.g, data.b);
    }
}
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Color, "class//./input//Color");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Vector, "class//./input//Vector");
