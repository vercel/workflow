# Workflow directives specification

The `"use step"` and `"use workflow"` directives work similarly to `"use server"` in React. A function marked with `"use step"` represents a durable step that executes on the server. A function marked with `"use workflow"` represents a durable workflow that orchestrates steps.

The SWC plugin has three modes: **step mode**, **workflow mode**, and **detect mode**.

## Directive placement

Directives can be placed:
1. At the **top of a file** (module-level) to mark all exported async functions
2. At the **start of a function body** to mark individual functions

Directives must:
- Be at the beginning (above any other code, including imports for module-level)
- Use single or double quotes (not backticks)
- Comments before directives are allowed

## JSON manifest

All modes emit a JSON manifest comment at the top of the file containing metadata about discovered workflows, steps, and classes with custom serialization:

```javascript
/**__internal_workflows{"workflows":{"path/file.ts":{"myWorkflow":{"workflowId":"workflow//./path/file//myWorkflow"}}},"steps":{"path/file.ts":{"myStep":{"stepId":"step//./path/file//myStep"}}},"classes":{"path/file.ts":{"Point":{"classId":"class//./path/file//Point"}}}}*/
```

The manifest includes:
- **`workflows`**: Map of workflow function names to their `workflowId`
- **`steps`**: Map of step function names to their `stepId`
- **`classes`**: Map of class names with custom serialization to their `classId`

This manifest is used by bundlers and the runtime to discover and register workflows, steps, and serializable classes.

## ID generation

IDs use the format `{type}//{modulePath}//{identifier}` where:
- `type` is `workflow`, `step`, or `class`
- `modulePath` is either:
  - A **module specifier** with version (e.g., `point@0.0.1`, `@myorg/shared@1.2.3`, `workflow/internal/builtins@4.0.0`) when provided via plugin config
  - A **relative path** prefixed with `./` (e.g., `./src/jobs/order`) when no specifier is provided
- `identifier` is the function/class name, with nested functions using `/` separators

### Module specifier support

The plugin accepts an optional `moduleSpecifier` config option that allows IDs to be based on the 
import specifier rather than the file path. This is useful for:

1. **Package exports conditions**: When a package has different entrypoints for different conditions 
   (e.g., `"workflow"` vs `"default"` in `package.json` exports), the same import specifier 
   can map to different files. Using the specifier ensures consistent IDs across conditions.

2. **Versioned IDs**: Package specifiers can include versions (e.g., `point@0.0.1`) for cache invalidation.

3. **Stable cross-bundle references**: Classes serialized in one bundle can be deserialized in another 
   bundle as long as both use the same module specifier.

4. **Subpath exports**: For packages with multiple entry points (e.g., `workflow/internal/builtins`), 
   the full subpath is included in the module specifier to avoid collisions between steps with the 
   same name in different subpaths.

**Plugin Config:**
```json
{
  "mode": "step",
  "moduleSpecifier": "workflow/internal/builtins@4.0.0"
}
```

### Examples

**With module specifier (npm package root export):**
- `class//point@0.0.1//Point`
- `step//@myorg/tasks@2.0.0//processOrder`

**With module specifier (npm package subpath export):**
- `step//workflow/internal/builtins@4.0.0//__builtin_response_json`
- `class//@myorg/shared/models@1.0.0//User`

**Without module specifier (local files):**
- `workflow//./src/jobs/order//processOrder`
- `step//./src/jobs/order//fetchData`
- `step//./src/jobs/order//processOrder/innerStep` (nested step)
- `step//./src/jobs/order//MyClass.staticMethod` (static method)
- `step//./src/jobs/order//MyClass#instanceMethod` (instance method)
- `class//./src/models/Point//Point` (serialization class)

Note: File extensions are stripped from local paths for cleaner IDs.

---

## Step mode

In step mode, step function bodies are kept intact and registered using an inline IIFE that stores them in a global registry via `Symbol.for("@workflow/core//registeredSteps")`, with no module imports. Workflow functions throw an error if called directly (since they should only run in the workflow runtime).

After the step-mode rewrite, the transform also runs a dead code elimination (DCE) pass. Because step bodies are preserved (unlike workflow mode where they are replaced with proxies), imports, helper functions, and other declarations referenced from step bodies are also preserved. However, code that is reachable only from workflow bodies that were replaced with throwing stubs can still be removed. A reference counts even when it appears only inside a destructuring-default initializer. For example, `const { ttl = TTL } = options;` counts as a use of `TTL`, so the declaration is not stripped.

Object property step functions are hoisted to module-level variables and the original call site is replaced with a reference to the hoisted variable, making `.stepId` accessible at the call site.

### Basic step function

Input:
```javascript
export async function add(a, b) {
  "use step";
  return a + b;
}
```

Output:
```javascript
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"}}}}*/;
export async function add(a, b) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(add, "step//./input//add");
```

### Arrow function step

Input:
```javascript
export const multiply = async (a, b) => {
  "use step";
  return a * b;
};
```

Output:
```javascript
/**__internal_workflows{"steps":{"input.js":{"multiply":{"stepId":"step//./input//multiply"}}}}*/;
export const multiply = async (a, b) => {
    return a * b;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(multiply, "step//./input//multiply");
```

### Workflow functions in step mode

Workflow functions throw an error to prevent direct execution and have `workflowId` attached:

Input:
```javascript
export async function myWorkflow(data) {
  "use workflow";
  return await processData(data);
}
```

Output:
```javascript
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
export async function myWorkflow(data) {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
```

### Nested steps in workflows

Steps defined inside workflow functions are hoisted to module level with prefixed names:

Input:
```javascript
export async function example(a, b) {
  "use workflow";

  async function innerStep(x, y) {
    "use step";
    return x + y;
  }

  return await innerStep(a, b);
}
```

Output:
```javascript
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.js":{"innerStep":{"stepId":"step//./input//innerStep"}}}}*/;
async function example$innerStep(x, y) {
    return x + y;
}
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(example$innerStep, "step//./input//example/innerStep");
```

### Steps in nested object properties

Step functions can be defined inside deeply nested object properties, including function call arguments. The plugin recursively processes nested objects to find step functions, generating compound paths for the step IDs.

Input:
```javascript
import { agent } from "experimental-agent";

export const vade = agent({
  tools: {
    VercelRequest: {
      execute: async (input, ctx) => {
        "use step";
        return 1 + 1;
      },
    },
  },
});
```

Output (Step Mode):
```javascript
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
var vade$tools$VercelRequest$execute = async function(input, ctx) {
    return 1 + 1;
};
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: vade$tools$VercelRequest$execute
        }
    }
});
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(vade$tools$VercelRequest$execute, "step//./input//vade/tools/VercelRequest/execute");
```

Note: Step functions are hoisted as regular function expressions (not arrow functions) to preserve `this` binding when called with `.call()` or `.apply()`. This applies even when the original step function was defined as an arrow function.

Output (Workflow Mode):
```javascript
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//vade/tools/VercelRequest/execute")
        }
    }
});
```

Note: In step mode, nested object property step functions are hoisted and registered via a self-contained IIFE (no imports). The original call site is replaced with a reference to the hoisted variable.

Note: The step ID includes the full path through nested objects (`vade/tools/VercelRequest/execute`), while the hoisted variable name uses `$` as the separator (`vade$tools$VercelRequest$execute`) to create a valid JavaScript identifier.

#### Shorthand method syntax

Shorthand method syntax (non-arrow functions) is also supported in nested object properties:

Input:
```javascript
import { agent } from "experimental-agent";

export const vade = agent({
  tools: {
    VercelRequest: {
      async execute(input, { experimental_context }) {
        "use step";
        return 1 + 1;
      },
    },
  },
});
```

Output (Step Mode):
```javascript
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
var vade$tools$VercelRequest$execute = async function(input, { experimental_context }) {
    return 1 + 1;
};
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: vade$tools$VercelRequest$execute
        }
    }
});
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(vade$tools$VercelRequest$execute, "step//./input//vade/tools/VercelRequest/execute");
```

Note: Shorthand methods are hoisted as regular function expressions (not arrow functions) to preserve `this` binding when called with `.call()` or `.apply()`. Closure variables are handled the same way as other step functions.

### Closure variables

When nested steps capture closure variables, the plugin extracts them using an inline IIFE that reads from the workflow step context storage via `Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")`. Closure variable detection recursively walks the step function body, including nested function, arrow, method, getter/setter, and class bodies. It collects identifiers that are not parameters, local declarations, known globals, module-level imports, or module-level declarations. TypeScript expression wrappers (`as`, `satisfies`, `!`, type assertions, `const` assertions, and instantiation expressions) are traversed to reach the inner expression. Module-level imports and declarations (functions, variables, and classes) are excluded because they are available directly in the step bundle and should not be serialized as closure values:

Input:
```javascript
function wrapper(multiplier) {
  return async () => {
    "use step";
    return 10 * multiplier;
  };
}
```

Output:
```javascript
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"}}}}*/;
var wrapper$_anonymousStep0 = async () => {
    const { multiplier } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return 10 * multiplier;
};
function wrapper(multiplier) {
    return async () => {
        return 10 * multiplier;
    };
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(wrapper$_anonymousStep0, "step//./input//wrapper/_anonymousStep0");
```

Note: The hoisted copy (`wrapper$_anonymousStep0`) uses an inline IIFE to extract closure variables from the workflow step context for workflow-driven execution, while the original function body is preserved in `wrapper()` with the directive stripped. This allows the enclosing function to work correctly when called directly (non-workflow), since JavaScript's normal closure semantics naturally capture `multiplier`.

### Instance method step

Instance methods can use `"use step"` if the class provides custom serialization methods. The `this` context is serialized when calling the step and deserialized before execution.

Input:
```javascript
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
  async add(amount) {
    'use step';
    return this.value + amount;
  }
}
```

Output:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Counter#add":{"stepId":"step//./input//Counter#add"}}},"classes":{"input.js":{"Counter":{"classId":"class//./input//Counter"}}}}*/;
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
    async add(amount) {
        return this.value + amount;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(Counter.prototype["add"], "step//./input//Counter#add");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(Counter, "class//./input//Counter");
```

Note: Instance methods use `#` in the step ID (e.g., `Counter#add`) and are registered via `ClassName.prototype["methodName"]`.

### Module-level directive

Input:
```javascript
"use step";

export async function add(a, b) {
  return a + b;
}

export async function subtract(a, b) {
  return a - b;
}
```

Output:
```javascript
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"},"subtract":{"stepId":"step//./input//subtract"}}}}*/;
export async function add(a, b) {
    return a + b;
}
export async function subtract(a, b) {
    return a - b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(add, "step//./input//add");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(subtract, "step//./input//subtract");
```

---

## Workflow mode

In workflow mode, step function bodies are replaced with a `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` call. Workflow functions keep their bodies and are registered with `globalThis.__private_workflows.set()`.

After the workflow-mode rewrite, the transform also runs a dead code elimination (DCE) pass. Because step bodies are replaced with step proxies, imports, helper functions, nested steps, and other pure statements that were only referenced from those original step bodies become eligible for removal. Exports and any identifiers still referenced by the transformed workflow code are preserved. A reference counts even when it appears only inside a destructuring-default initializer. For example, `const { ttl = TTL } = options;` counts as a use of `TTL`, so the declaration is not stripped.

### Step functions

Input:
```javascript
export async function add(a, b) {
  "use step";
  return a + b;
}
```

Output:
```javascript
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"}}}}*/;
export var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//add");
```

### Workflow functions

Input:
```javascript
export async function myWorkflow(data) {
  "use workflow";
  const result = await fetchData(data);
  return result;
}
```

Output:
```javascript
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
export async function myWorkflow(data) {
    const result = await fetchData(data);
    return result;
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
globalThis.__private_workflows.set("workflow//./input//myWorkflow", myWorkflow);
```

### Nested steps with closures

When steps capture closure variables, a closure function is passed as the second argument:

Input:
```javascript
export async function myWorkflow(config) {
  "use workflow";
  let count = 0;

  async function increment() {
    "use step";
    return count + 1;
  }

  return await increment();
}
```

Output:
```javascript
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}},"steps":{"input.js":{"increment":{"stepId":"step//./input//increment"}}}}*/;
export async function myWorkflow(config) {
    let count = 0;
    var increment = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//myWorkflow/increment", () => ({
        count
    }));
    return await increment();
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
globalThis.__private_workflows.set("workflow//./input//myWorkflow", myWorkflow);
```

---

---

## Detect mode

Detect mode is a lightweight, non-transforming mode used during the build discovery phase. It walks the AST to find `"use workflow"` and `"use step"` directives and custom serialization classes, then emits the JSON manifest comment without modifying any code.

This allows the build system to perform a fast regular expression pre-scan to identify candidate files, then run the SWC plugin in detect mode only on those candidates to validate at the AST level. The plugin eliminates false positives (for example, directive-like strings inside template literals) because it recognizes only genuine directive expression statements.

**Plugin Config:**
```json
{
  "mode": "detect",
  "moduleSpecifier": null
}
```

Given the same input as the other mode examples, detect mode produces:

```javascript
/**__internal_workflows{"steps":{"input.js":{"fetchInventory":{"stepId":"step//./input//fetchInventory"}}},"workflows":{"input.js":{"placeOrder":{"workflowId":"workflow//./input//placeOrder"}}}}*/
// ... original source code unchanged ...
```

---

## Static methods

Static class methods can be marked with directives. Instance methods are **not supported**.

### Static step method

Input:
```javascript
export class MyService {
  static async process(data) {
    "use step";
    return data.value * 2;
  }
}
```

Output (Step Mode):
```javascript
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
    static async process(data) {
        return data.value * 2;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(MyService.process, "step//./input//MyService.process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(MyService, "class//./input//MyService");
```

Output (Workflow Mode):
```javascript
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(MyService, "class//./input//MyService");
```

### Static workflow method

Input:
```javascript
export class JobRunner {
  static async runJob(jobId) {
    "use workflow";
    return await processJob(jobId);
  }
}
```

Output (Workflow Mode):
```javascript
/**__internal_workflows{"workflows":{"input.js":{"JobRunner.runJob":{"workflowId":"workflow//./input//JobRunner.runJob"}}}}*/;
export class JobRunner {
    static async runJob(jobId) {
        return await processJob(jobId);
    }
}
JobRunner.runJob.workflowId = "workflow//./input//JobRunner.runJob";
globalThis.__private_workflows.set("workflow//./input//JobRunner.runJob", JobRunner.runJob);
```

---

## Custom serialization

Classes can define custom serialization/deserialization using symbols. These are automatically registered for use across workflow boundaries.

Input:
```javascript
export class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  static [Symbol.for("workflow-serialize")](instance) {
    return { x: instance.x, y: instance.y };
  }

  static [Symbol.for("workflow-deserialize")](data) {
    return new Point(data.x, data.y);
  }
}
```

Output:
```javascript
/**__internal_workflows{"classes":{"input.js":{"Point":{"classId":"class//./input//Point"}}}}*/;
export class Point {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
    static [Symbol.for("workflow-serialize")](instance) {
        return { x: instance.x, y: instance.y };
    }
    static [Symbol.for("workflow-deserialize")](data) {
        return new Point(data.x, data.y);
    }
}
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(Point, "class//./input//Point");
```

The registration is **inlined as a self-contained IIFE** that uses `Symbol.for("workflow-class-registry")` on `globalThis`. This approach works for third-party packages that don't depend on the `workflow` package directly and requires no module imports.

You can also use imported symbols from `@workflow/serde`:

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export class Vector {
  static [WORKFLOW_SERIALIZE](instance) { ... }
  static [WORKFLOW_DESERIALIZE](data) { ... }
}
```

### CommonJS `require()` patterns

The plugin also detects serialization symbols obtained via CommonJS `require()` calls. This handles code that has been pre-compiled from ESM to CommonJS by tools like TypeScript (`tsc`), esbuild, or tsup.

**Namespace require** applies when the entire module is assigned to a variable and symbols are accessed as properties:

```javascript
const serde_1 = require("@workflow/serde");

class Sandbox {
  static [serde_1.WORKFLOW_SERIALIZE](instance) {
    return { sandbox: instance.sandbox };
  }
  static [serde_1.WORKFLOW_DESERIALIZE](data) {
    const instance = Object.create(Sandbox.prototype);
    instance.sandbox = data.sandbox;
    return instance;
  }
}
```

**Destructured require** applies when symbols are destructured directly from the `require()` call:

```javascript
const { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } = require("@workflow/serde");

class Sandbox {
  static [WORKFLOW_SERIALIZE](instance) {
    return { sandbox: instance.sandbox };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    const instance = Object.create(Sandbox.prototype);
    instance.sandbox = data.sandbox;
    return instance;
  }
}
```

Both patterns produce the same output as the ESM import version. The plugin appends a `registerSerializationClass()` call and includes the class in the manifest.

Destructured require also supports renaming (analogous to `import { WORKFLOW_SERIALIZE as WS }`):

```javascript
const { WORKFLOW_SERIALIZE: WS, WORKFLOW_DESERIALIZE: WD } = require("@workflow/serde");
```

### Class expressions

Class *declarations* (`class Foo { ... }`, `export class Foo { ... }`) are registered by module-level statements appended to the module body that reference the class by name (see the examples above).

Class *expressions* are handled differently, because there is no guarantee that the class is reachable through a module-scope binding: bundlers routinely emit `var Foo = class { ... }` or `var Foo = class _Foo { ... }` (where `_Foo` is only in scope inside the class body), and a class expression can appear anywhere an expression can (`exports.Foo = class {}`, `{ Foo: class {} }`, `foo(class Named {})`, `var A = class {}, B = class {}`). Instead of emitting module-level code that refers to the class by name, the plugin wraps the class expression in an IIFE that receives the class as its argument, performs the registrations, and returns the class:

Input (e.g., after tsdown/esbuild pre-bundling; this is the shape `@vercel/sandbox` ships):
```javascript
var FileSystem = class {
  constructor(sandbox) { this.sandbox = sandbox; }
  async readFile(path) { "use step"; return this.sandbox.read(path); }
};
export { FileSystem };
```

Output (step mode):
```javascript
/**__internal_workflows{"steps":{"input.js":{"FileSystem#readFile":{"stepId":"step//./input//FileSystem#readFile"}}},"classes":{"input.js":{"FileSystem":{"classId":"class//./input//FileSystem"}}}}*/;
var FileSystem = function(__wf_cls) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map()), __wf_fn;
    __wf_fn = __wf_cls.prototype["readFile"];
    __wf_reg.set("step//./input//FileSystem#readFile", __wf_fn);
    __wf_fn.stepId = "step//./input//FileSystem#readFile";
    Object.defineProperty(__wf_fn, "name", { value: "readFile", configurable: true });
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//FileSystem", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: "class//./input//FileSystem", writable: false, enumerable: false, configurable: false });
    return __wf_cls;
}(class FileSystem {
    constructor(sandbox) { this.sandbox = sandbox; }
    async readFile(path) { return this.sandbox.read(path); }
});
export { FileSystem };
```

Output (workflow mode):
```javascript
var FileSystem = function(__wf_cls) {
    __wf_cls.prototype["readFile"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//FileSystem#readFile");
    var __wf_cls_sym = Symbol.for("workflow-class-registry"), __wf_cls_reg = globalThis[__wf_cls_sym] || (globalThis[__wf_cls_sym] = new Map());
    __wf_cls_reg.set("class//./input//FileSystem", __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { /* ... */ });
    return __wf_cls;
}(class FileSystem {
    constructor(sandbox) { this.sandbox = sandbox; }
});
```

Note that:
- The IIFE closes over the class value itself (`__wf_cls`), so the registration does not depend on any name being in scope at module level. The same output shape is produced for every position a class expression can appear in.
- Everything recorded for the class (step methods, getters, custom serialization, static workflow methods) is emitted inside the single IIFE, in the same order as the module-level emission for class declarations. The registry lookups are hoisted once per registry rather than repeated per registration.
- A class expression with nothing to register is left untouched.
- Registration runs when the class expression is evaluated, which for a module-level class expression is module load, the same as for class declarations.
- `export default class { ... }` is a `ClassExpr` in the AST but not an expression position; it is handled by the rewrite described below rather than by the IIFE.

#### Class names for IDs

The IIFE removes the need to *reference* the class by name, but step and class IDs still need a name (`step//<module>//<ClassName>#<method>`). The name is resolved, in order of preference, from:

1. The variable the expression is assigned to: `var Foo = class _Foo {}` uses `Foo`, not `_Foo`. This also covers `let Foo; Foo = class {}`, parenthesized initializers (`var Foo = (class {})`), and chained assignments (`var Foo = exports.Foo = class {}`). With multiple declarators (`var A = class {}, B = class {}`) each class resolves to its own binding.
2. The class expression's own identifier: `foo(class Plugin {})` uses `Plugin`.
3. The property the expression is assigned to or defined under: `exports.Foo = class {}` and `{ Foo: class {} }` use `Foo` (string keys such as `'kebab-job'` are accepted as-is).

Names from (1) and (2) are bindings that already refer to the class, so when the class expression is anonymous the binding name is inserted as the class's own identifier (`var Foo = class {}` becomes `(...)(class Foo {})`). Passing the class as a call argument would otherwise defeat the `.name` inference the original assignment provided. For typical usage this is behaviorally equivalent to `var Foo = class Foo {}`; an inner class-scoped `Foo` binding is introduced, which can differ in edge cases that assign to or shadow that name inside the class body. Names from (3) are *not* inserted as an identifier, since `exports.Foo = class { m() { return Foo; } }` may refer to an unrelated outer `Foo`; the IIFE instead sets `.name` at runtime with `Object.defineProperty(__wf_cls, "name", { value: "Foo", configurable: true })`.

Classes that already have an identifier (e.g. `class _Bash { ... }`) are never renamed.

#### Unnameable and nested classes are errors

If a class expression has `"use step"`/`"use workflow"` methods, `"use step"` getters, or custom serialization, and no name can be derived (e.g. `foo(class { ... })`, `[class { ... }]`, `cond ? class { ... } : null`), the plugin emits a compile error:

```
Anonymous class expressions cannot use "use step" methods. Assign the class to a variable (e.g. `const MyClass = class { ... }`) or give it a name (`class MyClass { ... }`) so the compiler can reference it when registering it at module level
```

Likewise, a class (declaration or expression) that uses those features but is declared *inside a function* is an error:

```
Classes using "use step" methods must be declared at the top level of the module, not inside a function. The compiler registers the class at module level and cannot reference a class declared in an inner scope
```

Step registration must happen at module load for the step to be resolvable by ID; a class inside a function would only be registered when (and each time) that function runs. Earlier versions of the plugin emitted a placeholder `AnonymousClass` name (or the inner class's name) in these situations, which produced module-level code that threw a `ReferenceError` as soon as the module was evaluated. At most one error is reported per class, at the first offending member; classes without steps or serialization are unaffected. No errors are emitted in `detect` mode, which generates no code.

### Anonymous default class export rewriting

When an anonymous class with serialization methods or step methods is exported as the default export, the plugin rewrites it into a `const` declaration + re-export so that the class has a binding name accessible at module scope. `export default class { ... }` is not an expression position, so the registration IIFE used for class expressions does not apply; the class is instead registered by module-level statements that reference the generated `const`.

Input:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export default class {
  constructor(id) { this.id = id; }
  static [WORKFLOW_SERIALIZE](inst) { return { id: inst.id }; }
  static [WORKFLOW_DESERIALIZE](data) { return new this(data.id); }
  async process(input) { "use step"; return { result: input }; }
}
```

Output (step mode):
```javascript
const __DefaultClass = class __DefaultClass {
    constructor(id) { this.id = id; }
    // ... serde methods preserved ...
    async process(input) { return { result: input }; }
};
export default __DefaultClass;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(__DefaultClass.prototype["process"], "step//./input//__DefaultClass#process");
(function(__wf_cls, __wf_id) { /* ... */ })(__DefaultClass, "class//./input//__DefaultClass");
```

Note that:
- The anonymous class `export default class { ... }` is rewritten to `const __DefaultClass = class __DefaultClass { ... }; export default __DefaultClass;`
- When the class has serialization methods, the class expression also gets the binding name re-inserted (e.g., `class __DefaultClass { ... }`). For step-only classes without serde, the class expression remains anonymous (e.g., `class { ... }`), but the `const` binding name is what matters for module-scope registration code
- The generated name `__DefaultClass` is used for all registrations (step, class, serde)
- If `__DefaultClass` is already declared in scope, the name is suffixed (`__DefaultClass$1`, etc.)
- Named default exports (e.g., `export default class MyService { ... }`) are not rewritten because the class name `MyService` is already in scope

### File discovery for custom serialization

Files containing classes with custom serialization are automatically discovered for transformation, even if they don't contain `"use step"` or `"use workflow"` directives. The discovery mechanism looks for:

1. **Imports from `@workflow/serde`**: Files that import `WORKFLOW_SERIALIZE` or `WORKFLOW_DESERIALIZE` from `@workflow/serde`
2. **Direct Symbol.for usage**: Files containing `Symbol.for('workflow-serialize')` or `Symbol.for('workflow-deserialize')`
3. **CommonJS `require()` calls**: Files that use `require("@workflow/serde")` (or any module) and access `WORKFLOW_SERIALIZE` or `WORKFLOW_DESERIALIZE` via destructuring or namespace property access

This allows serialization classes to be defined in separate files (such as Next.js API routes or utility modules) and still be registered in the serialization system when the application is built.

### Cross-context class registration

Classes with custom serialization are automatically included in **all bundle contexts** (step and workflow) to ensure they can be properly serialized and deserialized when crossing execution boundaries:

| Boundary | Serializer | Deserializer | Example |
|----------|------------|--------------|---------|
| Workflow → Step | Workflow mode | Step mode | Passing a `Point` instance as step argument |
| Step → Workflow | Step mode | Workflow mode | Returning a `Point` instance from a step |

The build system automatically discovers all files containing serializable classes and includes them in each bundle, regardless of where the class is originally defined. This ensures the class registry has all necessary classes for any serialization boundary the data may cross.

For example, if a class `Point` is defined in `models/point.ts` and only used in step code:
- The **step bundle** includes `Point` because the step file imports it
- The **workflow bundle** also includes `Point` so it can deserialize step return values

This cross-registration happens automatically during the build process - no manual configuration is required.

---

## Default exports

Anonymous default exports are given the name `__default`:

Input:
```javascript
export default async (data) => {
  "use workflow";
  return await process(data);
};
```

Output (Workflow Mode):
```javascript
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//./input//default"}}}}*/;
const __default = async (data) => {
    return await process(data);
};
__default.workflowId = "workflow//./input//default";
globalThis.__private_workflows.set("workflow//./input//default", __default);
export default __default;
```

---

## Validation errors

The plugin emits errors for invalid usage:

| Error | Description |
|-------|-------------|
| Non-async workflow function | Functions with `"use workflow"` must be async (step functions may be sync) |
| Instance methods with `"use workflow"` | Only static methods can have `"use workflow"` (not instance methods) |
| Getters with `"use workflow"` | Getters cannot be marked with `"use workflow"` |
| Misplaced directive | Directive must be at top of file or start of function body |
| Conflicting directives | Cannot have both `"use step"` and `"use workflow"` at module level |
| Invalid exports (`"use workflow"`) | Module-level `"use workflow"` files can only export async functions |
| Invalid exports (`"use step"`) | Module-level `"use step"` files can only export functions (sync or async) |
| Misspelled directive | Detects typos like `"use steps"` or `"use workflows"` |
| Unnameable class expression | An anonymous class expression with step/workflow methods, step getters, or custom serialization in a position that provides no name (e.g. `foo(class { ... })`) |
| Nested class | A class with step/workflow methods, step getters, or custom serialization declared inside a function rather than at the module's top level |

---

## Supported function forms

The plugin supports various function declaration styles. Step functions may be synchronous or asynchronous. Workflow functions must be async.

- `async function name() { "use step"; }` - Async function declaration
- `function name() { "use step"; }` - Sync function declaration
- `const name = async () => { "use step"; }` - Async arrow function
- `const name = () => { "use step"; }` - Sync arrow function
- `let name = async () => { "use step"; }` - Async arrow function with let
- `let name = () => { "use step"; }` - Sync arrow function with let
- `var name = async () => { "use step"; }` - Async arrow function with var
- `var name = () => { "use step"; }` - Sync arrow function with var
- `const name = async function() { "use step"; }` - Async function expression
- `const name = function() { "use step"; }` - Sync function expression
- `{ async method() { "use step"; } }` - Async object method
- `{ method() { "use step"; } }` - Sync object method
- `{ nested: { execute: async () => { "use step"; } } }` - Nested object property
- `static async method() { "use step"; }` - Static class method
- `async method() { "use step"; }` - Instance class method (requires custom serialization)
- `get name() { "use step"; }` - Object literal getter
- `get name() { "use step"; }` - Class instance getter (requires custom serialization)
- `static get name() { "use step"; }` - Static class getter

---

## Getter step functions

Getters (property accessors) can be marked with `"use step"` to make property access trigger a step invocation. Unlike regular step functions, getters cannot be `async` syntactically, but the framework treats them as async steps. The pattern `await obj.prop` works when `prop` is a getter step.

**Getters cannot be marked with `"use workflow"`**. Only `"use step"` is supported.

### Instance getter transformation

**Step mode**: The getter is preserved on the class with the directive stripped. Registration uses an inline IIFE with `Object.getOwnPropertyDescriptor` to extract the getter function:
```javascript
(function(__wf_fn, __wf_id) {
  var __wf_sym = Symbol.for("@workflow/core//registeredSteps"),
      __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
  __wf_reg.set(__wf_id, __wf_fn);
  __wf_fn.stepId = __wf_id;
})(Object.getOwnPropertyDescriptor(ClassName.prototype, "prop").get, "step_id");
```

**Workflow mode**: The getter is removed from the class body. A hoisted step proxy variable and `Object.defineProperty` call are emitted:
```javascript
var __step_ClassName$prop = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id");
Object.defineProperty(ClassName.prototype, "prop", {
  get() { return __step_ClassName$prop.call(this); },
  configurable: true,
  enumerable: false
});
```

### Static getter transformation

Same as instance getters but targets `ClassName` instead of `ClassName.prototype`, and uses `.` separator in the step ID (same as static methods).

**Step mode**:
```javascript
(function(__wf_fn, __wf_id) {
  var __wf_sym = Symbol.for("@workflow/core//registeredSteps"),
      __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
  __wf_reg.set(__wf_id, __wf_fn);
  __wf_fn.stepId = __wf_id;
})(Object.getOwnPropertyDescriptor(ClassName, "prop").get, "step_id");
```

**Workflow mode**:
```javascript
var __step_ClassName$prop = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id");
Object.defineProperty(ClassName, "prop", {
  get() { return __step_ClassName$prop(); },
  configurable: true,
  enumerable: false
});
```

### Object literal getter transformation

**Step mode**: The getter body is hoisted into an async function wrapper for registration. The original getter is preserved with the directive stripped.

**Workflow mode**: A hoisted step proxy variable is created before the object literal. The getter body is replaced to call the proxy:
```javascript
var __step_varName$prop = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id");
const obj = {
  get prop() { return __step_varName$prop(); }
};
```

### Private member dead code elimination

In workflow mode, after stripping `"use step"` methods and getters from a class body, the plugin eliminates private class members that are no longer referenced by any remaining (non-private) member. This applies to both:

- **JS native private members**: `#field`, `#method()` (`ClassMember::PrivateMethod`, `ClassMember::PrivateProp`)
- **TypeScript `private` members**: `private field`, `private method()` (`ClassMethod`/`ClassProp` with `accessibility: Private`)

The algorithm is iterative. It first collects references from all public members, then expands the referenced set by scanning surviving private members' bodies for cross-references until the set stabilizes. This process enables cascading elimination: a private field referenced only by an unreferenced private method is also removed.

Input:
```typescript
export class Run {
  static [WORKFLOW_SERIALIZE](instance) { return { id: instance.id }; }
  static [WORKFLOW_DESERIALIZE](data) { return new Run(data.id); }

  id: string;
  private encryptionKeyPromise: Promise<any> | null = null;

  private async getEncryptionKey() {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = importKey(this.id);
    }
    return this.encryptionKeyPromise;
  }

  constructor(id: string) { this.id = id; }

  get value(): Promise<any> {
    'use step';
    return this.getEncryptionKey().then(() => getWorld().get(this.id));
  }
}
```

Workflow output:
```javascript
export class Run {
  static [WORKFLOW_SERIALIZE](instance) { return { id: instance.id }; }
  static [WORKFLOW_DESERIALIZE](data) { return new Run(data.id); }
  id;
  // private encryptionKeyPromise: ELIMINATED (only referenced by getEncryptionKey)
  // private getEncryptionKey(): ELIMINATED (only referenced by stripped getter)
  constructor(id) { this.id = id; }
}
// getter replaced with step proxy
var __step_Run$value = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id");
Object.defineProperty(Run.prototype, "value", {
  get() { return __step_Run$value.call(this); },
  configurable: true, enumerable: false
});
```

This optimization is critical for SDK classes like `Run`, where private helper methods reference Node.js-only imports (encryption, world access, and others). Eliminating the methods allows the downstream module-level DCE to also remove those imports from the workflow bundle.

---

## Parameter handling

The plugin supports complex parameter patterns including:

- Object destructuring: `async function({ a, b }) { "use step"; }`
- Array destructuring: `async function([first, second]) { "use step"; }`
- Default values: `async function({ x = 10 }) { "use step"; }`
- Rest parameters: `async function(a, ...rest) { "use step"; }`
- Nested destructuring: `async function({ user: { name } }) { "use step"; }`

---

## Disposable resources (`using` declarations)

The plugin supports directives inside functions that use TypeScript's `using` declarations (disposable resources). When TypeScript transforms `using` declarations, it wraps the function body in a try-catch-finally block:

Original TypeScript:
```typescript
async function testStep() {
  'use step';
  using writer = getWriter(getWritable());
  await writer.write('Hello, world!');
}
```

After TypeScript transformation:
```javascript
async function testStep() {
  const env = {
    stack: [],
    error: void 0,
    hasError: false
  };
  try {
    "use step";  // Directive is now inside try block
    const writer = _ts_add_disposable_resource(env, getWriter(getWritable()), false);
    await writer.write("Hello, world!");
  } catch (e) {
    env.error = e;
    env.hasError = true;
  } finally {
    _ts_dispose_resources(env);
  }
}
```

The plugin detects this pattern and correctly identifies the directive inside the try block, removing it during transformation while preserving the disposable resource handling.

---

## Lexical `this` capture in nested arrow steps

When a nested arrow-function step references `this` from an enclosing
function/method scope, the plugin captures that `this` so the workflow
runtime can rebind it inside the executing step body. This makes the
following pattern work. The user's class is responsible for providing
custom serialization (`WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE`) so the
captured `this` can survive the workflow→step boundary:

Input:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export class ReadFileTool {
  static [WORKFLOW_SERIALIZE](instance) {
    return { service: instance.service };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    return new ReadFileTool(data.service);
  }
  constructor(service) {
    this.service = service;
  }
  createTool(context) {
    return tool({
      execute: async (input) => {
        'use step';
        return this.service.readFileContent(input, context);
      },
    });
  }
}
```

Output (workflow mode): The proxy reference is wrapped with `.bind(this)`
so the runtime's step proxy captures the caller's `this` as `thisVal` on the
invocation queue item:
```javascript
createTool(context) {
  return tool({
    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")](
      "step//./input//_anonymousStep0",
      () => ({ context })
    ).bind(this),
  });
}
```

Output (step mode): The step body is hoisted as a regular `function` (not
an arrow) so the runtime's `stepFn.apply(thisVal, args)` can rebind `this`
to the value that was captured at call time:
```javascript
async function _anonymousStep0(input) {
  const { context } = (function() { /* closure-var IIFE */ })();
  return this.service.readFileContent(input, context);
}
```

Detection rules:
- Only `this` references that are **lexically captured by an arrow** count.
  An arrow function inherits `this` from its enclosing scope; a nested
  `function`/method/getter/setter introduces its own `this` and is therefore
  not traversed by the detector.
- The detector only flags arrows that are themselves step functions. A
  `this` reference inside a non-step nested arrow inside a step does still
  count, because the inner arrow inherits `this` from the step function
  body, which in turn inherits from the enclosing function.

Caveat: capturing `this` only works at runtime if the captured value is
serializable across the workflow→step boundary. Classes registered with
`WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` work; ordinary class
instances without custom serialization will fail at proxy-invocation time.

---

## Notes

- Arguments and return values must be serializable (JSON-compatible or using custom serialization)
- `this` is syntactically allowed inside step bodies, but it only carries a meaningful value in two shapes that both flow through the runtime's `thisVal` plumbing:
  1. **Instance-method steps** on a class with custom serialization (e.g. `Counter#add`). Calling `instance.add(...)` captures `instance` as `thisVal` so the step body sees `this === instance`.
  2. **Nested arrow steps that lexically capture `this`** (see "Lexical `this` Capture in Nested Arrow Steps" above). The compiler emits `.bind(this)` on the proxy in workflow mode and hoists the body as a regular `function` in step mode so `stepFn.apply(thisVal, args)` rebinds correctly.

  Other shapes (a top-level `async function` step that references `this`, an arrow step assigned to a module-level variable, etc.) compile without error. However, `this` will be whatever the caller of the step proxy passes, typically `null` or `undefined`, so referencing it is rarely useful.
- `arguments` is allowed inside `function`-form step bodies (it reflects the positional arguments the runtime passes via `stepFn.apply(thisVal, args)`). It does **not** work inside arrow-form steps. Arrows don't have their own `arguments` binding, and the compiler doesn't capture the enclosing scope's `arguments` the way it does for `this`. Use rest parameters (`...args`) instead if you need that pattern in an arrow step.
- `super` calls are not allowed in step functions
- Imports from the module are excluded from closure variable detection
- Module-level declarations (functions, variables, classes) are excluded from closure variable detection, since they are available directly in the step bundle and should not be serialized as closure values
- `new` expressions are analyzed for closure variables in the same way as regular function calls (both the callee and arguments are checked)
- Workflow functions always throw when called directly; use `start(workflow)` from `workflow/api` instead
