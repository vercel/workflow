// Anonymous class expressions in positions that provide no name (not assigned
// to a variable or property) still register through the IIFE; only their IDs
// need a name, so a deterministic `AnonymousClass<N>` is generated. The plugin
// used to emit a placeholder `AnonymousClass.prototype[...]` reference, which
// is a guaranteed ReferenceError at module evaluation (vercel/workflow#3929).
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

// Not counted: an anonymous class with nothing to register does not shift
// the numbering of the ones that follow.
export const plain = class {
  greet() {
    return 'hi';
  }
};

// AnonymousClass1: class passed directly as an argument
registerPlugin(class {
  async run() {
    'use step';
    return 'plugin';
  }
});

// AnonymousClass2: class as an array element (static step)
export const handlers = [
  class {
    static async execute() {
      'use step';
      return 'job';
    }
  },
];

// AnonymousClass3: class chosen by a conditional (step getter)
export const Worker = process.env.FAST
  ? class {
      get status() {
        'use step';
        return 'ok';
      }
    }
  : null;

// AnonymousClass4: custom serialization only
const registry = new Map([
  ['point', class {
    static [WORKFLOW_SERIALIZE](inst) {
      return { x: inst.x };
    }
    static [WORKFLOW_DESERIALIZE](data) {
      return { x: data.x };
    }
  }],
]);

// AnonymousClass5: static "use workflow" method
useModel(class {
  static async orchestrate() {
    'use workflow';
    return 'done';
  }
});

// Generated names avoid identifiers already declared in the module.
const AnonymousClass6 = 'taken';
useModel(class {
  async run() {
    'use step';
    return 'six';
  }
});

// A named class expression in the same position keeps its own name.
registerPlugin(class NamedPlugin {
  async run() {
    'use step';
    return 'named';
  }
});
