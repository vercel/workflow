// A nested arrow-function step assigned to a `const` inside a method. The
// arrow body references the enclosing method's `this`, so the compiler should
// hoist as a regular function (step mode) and `.bind(this)` the proxy
// (workflow mode).
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export class Counter {
  static [WORKFLOW_SERIALIZE](instance) {
    return { value: instance.value };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    return new Counter(data.value);
  }
  constructor(value) {
    this.value = value;
  }

  // The nested step is assigned to a `const`, exercising the var-declarator
  // code path (separate from the in-expression arrow path used for object
  // literals).
  async run(amount) {
    const addToValue = async (delta) => {
      'use step';
      return this.value + delta;
    };

    return addToValue(amount);
  }
}
