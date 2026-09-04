// Anonymous class expressions in positions that provide no name (not assigned
// to a variable or property) have nothing to derive a step/class ID from. The
// compiler used to emit `AnonymousClass.prototype[...]`, which is a guaranteed
// ReferenceError at module evaluation (vercel/workflow#3929). It must instead
// fail at compile time.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

// Error: class passed directly as an argument
registerPlugin(class {
  async run() {
    'use step';
    return 'plugin';
  }
});

// Error: class as an array element
export const handlers = [
  class {
    static async execute() {
      'use step';
      return 'job';
    }
  },
];

// Error: class chosen by a conditional
export const Worker = process.env.FAST
  ? class {
      get status() {
        'use step';
        return 'ok';
      }
    }
  : null;

// Error: custom serialization without a derivable name
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

// Error: static "use workflow" method
useModel(class {
  static async orchestrate() {
    'use workflow';
    return 'done';
  }
});

// OK: anonymous class expression without steps or serialization
export const plain = class {
  greet() {
    return 'hi';
  }
};

// OK: naming the class is all that is needed
registerPlugin(class NamedPlugin {
  async run() {
    'use step';
    return 'named';
  }
});
