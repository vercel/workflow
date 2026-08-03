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

export class Edge {
  static [WORKFLOW_SERIALIZE](inst) {
    return { value: inst.value };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    return new Edge(data.value);
  }
  constructor(value) {
    this.value = value;
  }

  // `this` appears only in a default parameter (no body reference).
  // Detector should still flag this and emit `.bind(this)`.
  withThisInDefaultParam() {
    return {
      execute: async (input = this.value) => {
        'use step';
        return input + 1;
      },
    };
  }

  // `this` appears only inside a class body declared *inside* the arrow.
  // The class field initializer's `this` is the new instance, NOT the
  // outer arrow's lexical `this`. Detector should NOT flag this.
  withClassBodyOnly() {
    return {
      execute: async () => {
        'use step';
        class Inner {
          self = this;
          getThis() {
            return this;
          }
        }
        return new Inner();
      },
    };
  }
}
