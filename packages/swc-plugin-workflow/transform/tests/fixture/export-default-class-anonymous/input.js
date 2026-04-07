// Test anonymous default class export with serde and step methods.
// The plugin should rewrite to:
//   const __DefaultClass = class __DefaultClass { ... };
//   export default __DefaultClass;
// so that registration code can reference the class at module scope.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export default class {
  constructor(id) {
    this.id = id;
  }

  static [WORKFLOW_SERIALIZE](instance) {
    return { id: instance.id };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new this(data.id);
  }

  async process(input) {
    "use step";
    return { result: input };
  }
}
