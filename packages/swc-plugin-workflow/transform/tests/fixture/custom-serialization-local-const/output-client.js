/**__internal_workflows{"classes":{"input.js":{"Circle":{"classId":"class//./input//Circle"},"Rectangle":{"classId":"class//./input//Rectangle"},"Triangle":{"classId":"class//./input//Triangle"}}}}*/;
// Test custom serialization with locally defined symbols using Symbol.for()
const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');
const WORKFLOW_DESERIALIZE = Symbol.for('workflow-deserialize');
// Class using locally defined symbols
export class Rectangle {
    constructor(width, height){
        this.width = width;
        this.height = height;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            width: instance.width,
            height: instance.height
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Rectangle(data.width, data.height);
    }
}
// Using different variable names
const MY_SERIALIZE = Symbol.for('workflow-serialize');
const MY_DESERIALIZE = Symbol.for('workflow-deserialize');
export class Circle {
    constructor(radius){
        this.radius = radius;
    }
    static [MY_SERIALIZE](instance) {
        return {
            radius: instance.radius
        };
    }
    static [MY_DESERIALIZE](data) {
        return new Circle(data.radius);
    }
}
// Exported const
export const EXPORTED_SERIALIZE = Symbol.for('workflow-serialize');
export const EXPORTED_DESERIALIZE = Symbol.for('workflow-deserialize');
export class Triangle {
    constructor(a, b, c){
        this.a = a;
        this.b = b;
        this.c = c;
    }
    static [EXPORTED_SERIALIZE](instance) {
        return {
            a: instance.a,
            b: instance.b,
            c: instance.c
        };
    }
    static [EXPORTED_DESERIALIZE](data) {
        return new Triangle(data.a, data.b, data.c);
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
})(Circle, "class//./input//Circle");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Rectangle, "class//./input//Rectangle");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Triangle, "class//./input//Triangle");
