import { registerSerializationClass } from "workflow/internal/class-serialization";
// Two classes with the same name but in different scopes
// This should produce an error because they would have the same classId
export const a = function() {
    return class A {
        static [Symbol.for('workflow-serialize')](instance) {
            return {
                x: instance.x
            };
        }
        static [Symbol.for('workflow-deserialize')](data) {
            return new A(data);
        }
    };
};
export const b = function() {
    return class A {
        static [Symbol.for('workflow-serialize')](instance) {
            return {
                y: instance.y
            };
        }
        static [Symbol.for('workflow-deserialize')](data) {
            return new A(data);
        }
    };
};
registerSerializationClass("class//input.js//A", A);
