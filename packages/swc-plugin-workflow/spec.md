# Workflow Directives Specification

The `"use step"` and `"use workflow"` directives work similarly to `"use server"` in React. A function marked with `"use step"` represents a durable step that executes on the server. A function marked with `"use workflow"` represents a durable workflow that orchestrates steps.

The SWC plugin has 4 modes: **Step mode**, **Workflow mode**, **Client mode**, and **Detect mode**.

## Directive Placement

Directives can be placed:
1. At the **top of a file** (module-level) to mark all exported async functions
2. At the **start of a function body** to mark individual functions

Directives must:
- Be at the very beginning (above any other code, including imports for module-level)
- Use single or double quotes (not backticks)
- Comments before directives are allowed

## JSON Manifest

All modes emit a JSON manifest comment at the top of the file containing metadata about discovered workflows, steps, and classes with custom serialization:

```javascript
/**__internal_workflows{"workflows":{"path/file.ts":{"myWorkflow":{"workflowId":"workflow//./path/file//myWorkflow"}}},"steps":{"path/file.ts":{"myStep":{"stepId":"step//./path/file//myStep"}}},"classes":{"path/file.ts":{"Point":{"classId":"class//./path/file//Point"}}}}*/
```

The manifest includes:
- **`workflows`**: Map of workflow function names to their `workflowId`
- **`steps`**: Map of step function names to their `stepId`
- **`classes`**: Map of class names with custom serialization to their `classId`

This manifest is used by bundlers and the runtime to discover and register workflows, steps, and serializable classes.

## ID Generation

IDs use the format `{type}//{modulePath}//{identifier}` where:
- `type` is `workflow`, `step`, or `class`
- `modulePath` is either:
  - A **module specifier** with version (e.g., `point@0.0.1`, `@myorg/shared@1.2.3`, `workflow/internal/builtins@4.0.0`) when provided via plugin config
  - A **relative path** prefixed with `./` (e.g., `./src/jobs/order`) when no specifier is provided
- `identifier` is the function/class name, with nested functions using `/` separators

### Module Specifier Support

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

## Step Mode

In step mode, step function bodies are kept intact and registered using an inline IIFE that stores them in a global registry via `Symbol.for("@workflow/core//registeredSteps")`, with no module imports. Workflow functions throw an error if called directly (since they should only run in the workflow runtime).

### Basic Step Function

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

### Arrow Function Step

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

### Workflow Functions in Step Mode

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

### Nested Steps in Workflows

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

### Steps in Nested Object Properties

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

Output (Client Mode):
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
vade$tools$VercelRequest$execute.stepId = "step//./input//vade/tools/VercelRequest/execute";
```

Note: In client mode, nested object property step functions are hoisted and have `stepId` set directly via inline property assignment. Step mode also uses inline registration (no import) via a self-contained IIFE. The original call site is replaced with a reference to the hoisted variable in both modes.

Note: The step ID includes the full path through nested objects (`vade/tools/VercelRequest/execute`), while the hoisted variable name uses `$` as the separator (`vade$tools$VercelRequest$execute`) to create a valid JavaScript identifier.

#### Shorthand Method Syntax

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

### Closure Variables

When nested steps capture closure variables, they are extracted using an inline IIFE that reads from the workflow step context storage via `Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")`. Closure variable detection recursively walks the step function body — including nested function, arrow, method, getter/setter, and class bodies — and collects identifiers that are not parameters, local declarations, known globals, module-level imports, or module-level declarations. TypeScript expression wrappers (`as`, `satisfies`, `!`, type assertions, `const` assertions, instantiation expressions) are traversed to reach the inner expression. Module-level imports and declarations (functions, variables, classes) are excluded since they are available directly in the step bundle and should not be serialized as closure values:

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

### Instance Method Step

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

### Module-Level Directive

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

## Workflow Mode

In workflow mode, step function bodies are replaced with a `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` call. Workflow functions keep their bodies and are registered with `globalThis.__private_workflows.set()`.

After the workflow-mode rewrite, the transform also runs a dead code elimination (DCE) pass. This pruning only affects the emitted workflow/client outputs, not step-mode output. In workflow mode, because step bodies are replaced with step proxies, imports, helper functions, nested steps, and other pure statements that were only referenced from those original step bodies become eligible for removal. Exports and any identifiers still referenced by the transformed workflow code are preserved.

### Step Functions

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

### Workflow Functions

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

### Nested Steps with Closures

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

## Client Mode

In client mode, step function bodies are preserved as-is (allowing local testing/execution), and step functions have their `stepId` property set so they can be properly serialized when passed across boundaries (e.g., as arguments to `start()` or returned from other step functions). Workflow functions throw an error and have `workflowId` attached for use with `start()`.

Like step mode, client mode also uses inline property assignments with no imports. The `stepId` property is set directly on the function, similar to how `workflowId` is set on workflow functions. The difference is that client mode uses a simple property assignment, while step mode uses an inline IIFE that also adds the function to the global step registry.

Client mode also runs the same DCE pass after transform. The key difference from workflow mode is that module-level step bodies are still preserved and executable, so any imports, local helpers, or other declarations that are referenced only from those step bodies must also be preserved. By contrast, code that is reachable only from workflow bodies that were replaced with throwing stubs can still be removed.

Note: Step functions nested inside other functions (whether workflow functions or regular functions) do NOT get `stepId` assignments in client mode because they are not accessible at module level. In practice, nested steps and helpers that are only reachable from a workflow body are often pruned by the client-mode DCE pass once that workflow body has been replaced.

### Step Functions

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
add.stepId = "step//./input//add";
```

### Workflow Functions

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

### Custom Serialization in Client Mode

Classes with custom serialization methods are also registered in client mode so that they can be properly serialized when passed to `start(workflow)`:

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

Output (Client Mode):
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

---

## Detect Mode

Detect mode is a lightweight, non-transforming mode used during the build discovery phase. It walks the AST to find `"use workflow"`, `"use step"` directives and custom serialization classes, then emits the JSON manifest comment — but does **not** modify any code.

This allows the build system to perform a fast regexp pre-scan to identify candidate files, then run the SWC plugin in detect mode only on those candidates to validate at the AST level. False positives (e.g. directive-like strings inside template literals) are eliminated because the plugin only recognises genuine directive expression statements.

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

## Static Methods

Static class methods can be marked with directives. Instance methods are **not supported**.

### Static Step Method

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

### Static Workflow Method

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

## Custom Serialization

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

The registration is **inlined as a self-contained IIFE** that uses `Symbol.for("workflow-class-registry")` on `globalThis`. This ensures it works for 3rd-party packages that don't depend on the `workflow` package directly — no module imports are needed.

You can also use imported symbols from `@workflow/serde`:

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export class Vector {
  static [WORKFLOW_SERIALIZE](instance) { ... }
  static [WORKFLOW_DESERIALIZE](data) { ... }
}
```

### CommonJS `require()` Patterns

The plugin also detects serialization symbols obtained via CommonJS `require()` calls. This handles code that has been pre-compiled from ESM to CommonJS by tools like TypeScript (`tsc`), esbuild, or tsup.

**Namespace require** — when the entire module is assigned to a variable and symbols are accessed as properties:

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

**Destructured require** — when symbols are destructured directly from the `require()` call:

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

Both patterns produce the same output as the ESM import version — a `registerSerializationClass()` call is appended and the class is included in the manifest.

Destructured require also supports renaming (analogous to `import { WORKFLOW_SERIALIZE as WS }`):

```javascript
const { WORKFLOW_SERIALIZE: WS, WORKFLOW_DESERIALIZE: WD } = require("@workflow/serde");
```

### Class Expressions with Binding Names

When a class expression is assigned to a variable, the plugin uses the variable name (binding name) for registration, not the internal class name. This is important because the internal class name is only accessible inside the class body.

Input:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

var Bash = class _Bash {
  constructor(command) {
    this.command = command;
  }

  static [WORKFLOW_SERIALIZE](instance) {
    return { command: instance.command };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new Bash(data.command);
  }
};
```

Output:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";
/**__internal_workflows{"classes":{"input.js":{"Bash":{"classId":"class//./input//Bash"}}}}*/;
var Bash = class _Bash {
    constructor(command) {
        this.command = command;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return { command: instance.command };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Bash(data.command);
    }
};
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(Bash, "class//./input//Bash");
```

Note that:
- The registration uses `Bash` (the variable name), not `_Bash` (the internal class name)
- The `classId` in the manifest also uses `Bash`
- This ensures the registration call references a symbol that's actually in scope at module level

This binding-name preference applies to **all** generated code that references the class at module scope, including:
- Class serialization registration IIFEs
- Step method registrations (inline IIFE calls)
- Workflow method stub assignments

For example, a class expression with step methods:

Input:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

var LanguageModel = class _LanguageModel {
  constructor(modelId) { this.modelId = modelId; }
  static [WORKFLOW_SERIALIZE](inst) { return { modelId: inst.modelId }; }
  static [WORKFLOW_DESERIALIZE](data) { return new _LanguageModel(data.modelId); }
  async doStream(prompt) { "use step"; return { stream: prompt }; }
  static async generate(input) { "use step"; return { result: input }; }
};
```

Output (step mode):
```javascript
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(LanguageModel.generate, "step//./input//LanguageModel.generate");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(LanguageModel.prototype["doStream"], "step//./input//LanguageModel#doStream");
(function(__wf_cls, __wf_id) { /* ... */ })(LanguageModel, "class//./input//LanguageModel");
```

All references use `LanguageModel` (the binding name), not `_LanguageModel` (the internal class expression name). Only a single class registration IIFE is emitted. The step IDs also use the binding name.

### Anonymous Class Expression Name Re-insertion

When a serializable class expression has no internal name (anonymous) but has a binding name from a variable declaration, the plugin re-inserts the binding name as the class expression's identifier. This handles the common case where upstream bundlers like esbuild/tsup transform `class Foo { ... }` into `var Foo = class { ... }` (stripping the class name).

Without this fix, the anonymous class would have an empty `.name` property, which can break downstream bundlers that rely on the class name for serialization registration.

Input (e.g., after tsup pre-bundling):
```javascript
var Shell = class {
  constructor(cmd) {
    this.cmd = cmd;
  }

  static [Symbol.for('workflow-serialize')](instance) {
    return { cmd: instance.cmd };
  }

  static [Symbol.for('workflow-deserialize')](data) {
    return new Shell(data.cmd);
  }
};
```

Output:
```javascript
/**__internal_workflows{"classes":{"input.js":{"Shell":{"classId":"class//./input//Shell"}}}}*/;
var Shell = class Shell {
    constructor(cmd) {
        this.cmd = cmd;
    }
    static [Symbol.for('workflow-serialize')](instance) {
        return { cmd: instance.cmd };
    }
    static [Symbol.for('workflow-deserialize')](data) {
        return new Shell(data.cmd);
    }
};
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(Shell, "class//./input//Shell");
```

Note that:
- The class expression `class { ... }` becomes `class Shell { ... }` — the binding name is inserted
- For typical usage, behavior is preserved while ensuring the `.name` property survives subsequent bundling (an inner class name binding is introduced, which can differ in edge cases that depend on assigning to or shadowing that name inside the class body)
- Classes that already have an internal name (e.g., `class _Bash { ... }`) are not modified
- Only classes with serialization methods (`WORKFLOW_SERIALIZE` and `WORKFLOW_DESERIALIZE`) are affected

### Anonymous Default Class Export Rewriting

When an anonymous class with serialization methods or step methods is exported as the default export, the plugin rewrites it into a `const` declaration + re-export so that the class has a binding name accessible at module scope. Without this, the generated registration code would reference an undefined variable.

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
- When the class has serialization methods, the class expression also gets the binding name re-inserted (e.g., `class __DefaultClass { ... }`). For step-only classes without serde, the class expression remains anonymous (e.g., `class { ... }`) — but the `const` binding name is what matters for module-scope registration code
- The generated name `__DefaultClass` is used for all registrations (step, class, serde)
- If `__DefaultClass` is already declared in scope, the name is suffixed (`__DefaultClass$1`, etc.)
- Named default exports (e.g., `export default class MyService { ... }`) are NOT rewritten — the class name `MyService` is already in scope

### File Discovery for Custom Serialization

Files containing classes with custom serialization are automatically discovered for transformation, even if they don't contain `"use step"` or `"use workflow"` directives. The discovery mechanism looks for:

1. **Imports from `@workflow/serde`**: Files that import `WORKFLOW_SERIALIZE` or `WORKFLOW_DESERIALIZE` from `@workflow/serde`
2. **Direct Symbol.for usage**: Files containing `Symbol.for('workflow-serialize')` or `Symbol.for('workflow-deserialize')`
3. **CommonJS `require()` calls**: Files that use `require("@workflow/serde")` (or any module) and access `WORKFLOW_SERIALIZE` or `WORKFLOW_DESERIALIZE` via destructuring or namespace property access

This allows serialization classes to be defined in separate files (such as Next.js API routes or utility modules) and still be registered in the serialization system when the application is built.

### Cross-Context Class Registration

Classes with custom serialization are automatically included in **all bundle contexts** (step, workflow, client) to ensure they can be properly serialized and deserialized when crossing execution boundaries:

| Boundary | Serializer | Deserializer | Example |
|----------|------------|--------------|---------|
| Client → Workflow | Client mode | Workflow mode | Passing a `Point` instance to `start(workflow)` |
| Workflow → Step | Workflow mode | Step mode | Passing a `Point` instance as step argument |
| Step → Workflow | Step mode | Workflow mode | Returning a `Point` instance from a step |
| Workflow → Client | Workflow mode | Client mode | Returning a `Point` instance from a workflow |

The build system automatically discovers all files containing serializable classes and includes them in each bundle, regardless of where the class is originally defined. This ensures the class registry has all necessary classes for any serialization boundary the data may cross.

For example, if a class `Point` is defined in `models/point.ts` and only used in step code:
- The **step bundle** includes `Point` because the step file imports it
- The **workflow bundle** also includes `Point` so it can deserialize step return values
- The **client bundle** also includes `Point` so it can deserialize workflow return values

This cross-registration happens automatically during the build process - no manual configuration is required.

---

## Default Exports

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

## Validation Errors

The plugin emits errors for invalid usage:

| Error | Description |
|-------|-------------|
| Non-async function | Functions with `"use step"` or `"use workflow"` must be async |
| Instance methods with `"use workflow"` | Only static methods can have `"use workflow"` (not instance methods) |
| Getters with `"use workflow"` | Getters cannot be marked with `"use workflow"` |
| Misplaced directive | Directive must be at top of file or start of function body |
| Conflicting directives | Cannot have both `"use step"` and `"use workflow"` at module level |
| Invalid exports | Module-level directive files can only export async functions |
| Misspelled directive | Detects typos like `"use steps"` or `"use workflows"` |

---

## Supported Function Forms

The plugin supports various function declaration styles:

- `async function name() { "use step"; }` - Function declaration
- `const name = async () => { "use step"; }` - Arrow function with const
- `let name = async () => { "use step"; }` - Arrow function with let
- `var name = async () => { "use step"; }` - Arrow function with var
- `const name = async function() { "use step"; }` - Function expression
- `{ async method() { "use step"; } }` - Object method
- `{ nested: { execute: async () => { "use step"; } } }` - Nested object property
- `static async method() { "use step"; }` - Static class method
- `async method() { "use step"; }` - Instance class method (requires custom serialization)
- `get name() { "use step"; }` - Object literal getter
- `get name() { "use step"; }` - Class instance getter (requires custom serialization)
- `static get name() { "use step"; }` - Static class getter

---

## Getter Step Functions

Getters (property accessors) can be marked with `"use step"` to make property access trigger a step invocation. Unlike regular step functions, getters cannot be `async` syntactically, but the framework treats them as async steps. The pattern `await obj.prop` works when `prop` is a getter step.

**Getters cannot be marked with `"use workflow"`** — only `"use step"` is supported.

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

**Client mode**: The getter is preserved with the directive stripped (no registration).

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

**Client mode**: Same as step mode — the getter body is hoisted for `stepId` assignment, original getter preserved.

---

## Parameter Handling

The plugin supports complex parameter patterns including:

- Object destructuring: `async function({ a, b }) { "use step"; }`
- Array destructuring: `async function([first, second]) { "use step"; }`
- Default values: `async function({ x = 10 }) { "use step"; }`
- Rest parameters: `async function(a, ...rest) { "use step"; }`
- Nested destructuring: `async function({ user: { name } }) { "use step"; }`

---

## Disposable Resources (`using` declarations)

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

## Notes

- Arguments and return values must be serializable (JSON-compatible or using custom serialization)
- The `this` keyword and `arguments` object are not allowed in step functions
- `super` calls are not allowed in step functions
- Imports from the module are excluded from closure variable detection
- Module-level declarations (functions, variables, classes) are excluded from closure variable detection, since they are available directly in the step bundle and should not be serialized as closure values
- `new` expressions are analyzed for closure variables in the same way as regular function calls (both the callee and arguments are checked)
- Workflow functions always throw when called directly; use `start(workflow)` from `workflow/api` instead
