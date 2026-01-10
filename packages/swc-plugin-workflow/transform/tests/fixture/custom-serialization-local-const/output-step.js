import { registerSerializationClass } from "workflow/internal/class-serialization";
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
registerSerializationClass("class//input.js//Triangle", Triangle);
registerSerializationClass("class//input.js//Circle", Circle);
registerSerializationClass("class//input.js//Rectangle", Rectangle);
