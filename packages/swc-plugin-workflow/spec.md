# Workflow Directives Specification

The `"use step"` and `"use workflow"` directives work similarly to `"use server"` in React. A function marked with `"use step"` represents a durable step that executes on the server. A function marked with `"use workflow"` represents a durable workflow that orchestrates steps.

The SWC plugin has 3 modes: **Step mode**, **Workflow mode**, and **Client mode**.

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

In step mode, step function bodies are kept intact and registered using `registerStepFunction` from `workflow/internal/private`. Workflow functions throw an error if called directly (since they should only run in the workflow runtime).

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
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"}}}}*/;
export async function add(a, b) {
    return a + b;
}
registerStepFunction("step//./input//add", add);
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
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"multiply":{"stepId":"step//./input//multiply"}}}}*/;
export const multiply = async (a, b) => {
    return a * b;
};
registerStepFunction("step//./input//multiply", multiply);
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
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.js":{"innerStep":{"stepId":"step//./input//innerStep"}}}}*/;
async function example$innerStep(x, y) {
    return x + y;
}
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
registerStepFunction("step//./input//example/innerStep", example$innerStep);
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
import { registerStepFunction } from "workflow/internal/private";
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//input.js//vade/tools/VercelRequest/execute"}}}}*/;
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
registerStepFunction("step//input.js//vade/tools/VercelRequest/execute", vade$tools$VercelRequest$execute);
```

Note: Step functions are hoisted as regular function expressions (not arrow functions) to preserve `this` binding when called with `.call()` or `.apply()`. This applies even when the original step function was defined as an arrow function.

Output (Workflow Mode):
```javascript
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//input.js//vade/tools/VercelRequest/execute"}}}}*/;
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//vade/tools/VercelRequest/execute")
        }
    }
});
```

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
import { registerStepFunction } from "workflow/internal/private";
import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//input.js//vade/tools/VercelRequest/execute"}}}}*/;
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
registerStepFunction("step//input.js//vade/tools/VercelRequest/execute", vade$tools$VercelRequest$execute);
```

Note: Shorthand methods are hoisted as regular function expressions (not arrow functions) to preserve `this` binding when called with `.call()` or `.apply()`. Closure variables are handled the same way as other step functions.

### Closure Variables

When nested steps capture closure variables, they are extracted using `__private_getClosureVars()`:

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
import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"}}}}*/;
var wrapper$_anonymousStep0 = async () => {
    const { multiplier } = __private_getClosureVars();
    return 10 * multiplier;
};
function wrapper(multiplier) {
    return wrapper$_anonymousStep0;
}
registerStepFunction("step//./input//wrapper/_anonymousStep0", wrapper$_anonymousStep0);
```

### Instance Method Step

Instance methods can use `"use step"` if the class provides custom serialization methods. The `this` context is serialized when calling the step and deserialized before execution.

Input:
```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';

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
import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
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
registerStepFunction("step//./input//Counter#add", Counter.prototype["add"]);
registerSerializationClass("class//./input//Counter", Counter);
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
import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"},"subtract":{"stepId":"step//./input//subtract"}}}}*/;
export async function add(a, b) {
    return a + b;
}
export async function subtract(a, b) {
    return a - b;
}
registerStepFunction("step//./input//add", add);
registerStepFunction("step//./input//subtract", subtract);
```

---

## Workflow Mode

In workflow mode, step function bodies are replaced with a `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` call. Workflow functions keep their bodies and are registered with `globalThis.__private_workflows.set()`.

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

In client mode, step function bodies are preserved as-is (allowing local testing/execution). Workflow functions throw an error and have `workflowId` attached for use with `start()`.

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
import { registerSerializationClass } from "workflow/internal/class-serialization";
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
registerSerializationClass("class//./input//Point", Point);
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
import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
    static async process(data) {
        return data.value * 2;
    }
}
registerStepFunction("step//./input//MyService.process", MyService.process);
registerSerializationClass("class//./input//MyService", MyService);
```

Output (Workflow Mode):
```javascript
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.process");
registerSerializationClass("class//./input//MyService", MyService);
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
import { registerSerializationClass } from "workflow/internal/class-serialization";
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
registerSerializationClass("class//./input//Point", Point);
```

You can also use imported symbols from `@workflow/serde`:

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export class Vector {
  static [WORKFLOW_SERIALIZE](instance) { ... }
  static [WORKFLOW_DESERIALIZE](data) { ... }
}
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
import { registerSerializationClass } from "workflow/internal/class-serialization";
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
registerSerializationClass("class//./input//Bash", Bash);
```

Note that:
- The registration uses `Bash` (the variable name), not `_Bash` (the internal class name)
- The `classId` in the manifest also uses `Bash`
- This ensures the registration call references a symbol that's actually in scope at module level

### File Discovery for Custom Serialization

Files containing classes with custom serialization are automatically discovered for transformation, even if they don't contain `"use step"` or `"use workflow"` directives. The discovery mechanism looks for:

1. **Imports from `@workflow/serde`**: Files that import `WORKFLOW_SERIALIZE` or `WORKFLOW_DESERIALIZE` from `@workflow/serde`
2. **Direct Symbol.for usage**: Files containing `Symbol.for('workflow-serialize')` or `Symbol.for('workflow-deserialize')`

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
- Workflow functions always throw when called directly; use `start(workflow)` from `workflow/api` instead
