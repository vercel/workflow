// Class expressions with "use step" methods must be registered through the
// binding that is in scope at module level. Bundlers emit several shapes for
// `class Foo {}` and all of them must resolve to the assigned binding rather
// than falling back to a placeholder name that does not exist at runtime.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

// tsdown/rolldown and esbuild emit this for classes that do not self-reference
// (this is the shape shipped by @vercel/sandbox, see vercel/workflow#3929).
var FileSystem = class {
  constructor(sandbox) {
    this.sandbox = sandbox;
  }
  async readFile(path) {
    'use step';
    return this.sandbox.read(path);
  }
};

// Multiple declarators in one statement: each class must get its own binding.
var Alpha = class {
    async run() {
      'use step';
      return 'alpha';
    }
  },
  Beta = class {
    async run() {
      'use step';
      return 'beta';
    }
  };

// Deferred assignment to a module-level binding.
let Gamma;
Gamma = class {
  async run() {
    'use step';
    return 'gamma';
  }
};

// Parenthesized initializer.
var Delta = (class {
  async run() {
    'use step';
    return 'delta';
  }
});

// Assignment chain (Babel CJS interop emits `var X = exports.X = class {}`).
var Epsilon = (exports.Epsilon = class {
  static async make() {
    'use step';
    return new Epsilon();
  }
});

// Assigned to a property: the property name is used for IDs but is not
// introduced as a binding (the class body's `Zeta` refers to the outer one).
const Zeta = 'outer';
exports.Zeta = class {
  async run() {
    'use step';
    return Zeta;
  }
};

// Object literal property value: the key is the name, with `.name` preserved.
export const handlers = {
  Job: class {
    static async execute() {
      'use step';
      return 'job';
    }
  },
  'kebab-job': class {
    get status() {
      'use step';
      return 'ok';
    }
  },
};

// A binding that nothing else references is still kept: evaluating the
// initializer is what registers the class.
const Unreferenced = class {
  static [WORKFLOW_SERIALIZE](inst) {
    return { v: inst.v };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    return { v: data.v };
  }
};

// Named class expression in an arbitrary position: its own name is used.
registerPlugin(
  class Plugin {
    async run() {
      'use step';
      return 'plugin';
    }
  }
);

export { FileSystem, Alpha, Beta, Gamma, Delta, Epsilon };
