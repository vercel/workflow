/**__internal_workflows{"classes":{"input.js":{"Point":{"classId":"class//./input//Point"}}}}*/;
// Class with custom serialization methods using symbols
export class Point {
    constructor(x, y){
        this.x = x;
        this.y = y;
    }
    static [Symbol.for('workflow-serialize')](instance) {
        return {
            x: instance.x,
            y: instance.y
        };
    }
    static [Symbol.for('workflow-deserialize')](data) {
        return new Point(data.x, data.y);
    }
}
// Regular class without serialization (should not be registered)
export class RegularClass {
    constructor(value){
        this.value = value;
    }
}
// Class with only serialize (not deserialize) - should not be registered
export class OnlySerialize {
    static [Symbol.for('workflow-serialize')](instance) {
        return {
            value: instance.value
        };
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
})(Point, "class//./input//Point");
