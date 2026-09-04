// Step method and serialization registrations are emitted at module level, so
// a class declared inside a function cannot be referenced by them. The
// compiler used to emit `Inner.prototype[...]` at module scope, which throws a
// ReferenceError at module evaluation. It must instead fail at compile time.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

// Error: class declaration inside a function
export function makeService() {
  class Service {
    async fetch() {
      'use step';
      return 'data';
    }
  }
  return new Service();
}

// Error: class expression assigned inside a function (this is also the shape
// esbuild produces when it wraps a module in a lazy `__esm` initializer)
var Lazy;
export function init() {
  Lazy = class {
    static async load() {
      'use step';
      return 'lazy';
    }
  };
}

// Error: custom serialization on a nested class
export const factory = () => {
  const Point = class {
    static [WORKFLOW_SERIALIZE](inst) {
      return { x: inst.x };
    }
    static [WORKFLOW_DESERIALIZE](data) {
      return new Point(data.x);
    }
  };
  return Point;
};

// OK: a nested class without steps or serialization
export function helper() {
  class Local {
    value() {
      return 1;
    }
  }
  return new Local();
}

// OK: module-level class declaration
export class Top {
  async run() {
    'use step';
    return 'top';
  }
}
