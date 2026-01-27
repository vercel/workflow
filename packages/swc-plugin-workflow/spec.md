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
/**__internal_workflows{"workflows":{"path/file.ts":{"myWorkflow":{"workflowId":"workflow//path/file.ts//myWorkflow"}}},"steps":{"path/file.ts":{"myStep":{"stepId":"step//path/file.ts//myStep"}}},"classes":{"path/file.ts":{"Point":{"classId":"class//path/file.ts//Point"}}}}*/
```

The manifest includes:
- **`workflows`**: Map of workflow function names to their `workflowId`
- **`steps`**: Map of step function names to their `stepId`
- **`classes`**: Map of class names with custom serialization to their `classId`

This manifest is used by bundlers and the runtime to discover and register workflows, steps, and serializable classes.

## ID Generation

IDs use the format `{type}//{filepath}//{identifier}` where:
- `type` is `workflow`, `step`, or `class`
- `filepath` is the relative path from project root (normalized to forward slashes)
- `identifier` is the function name, with nested functions using `/` separators

Examples:
- `workflow//src/jobs/order.ts//processOrder`
- `step//src/jobs/order.ts//fetchData`
- `step//src/jobs/order.ts//processOrder/innerStep` (nested step)
- `step//src/jobs/order.ts//MyClass.staticMethod` (static method)
- `class//src/models/Point.ts//Point` (serialization class)

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
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
export async function add(a, b) {
    return a + b;
}
registerStepFunction("step//input.js//add", add);
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
/**__internal_workflows{"steps":{"input.js":{"multiply":{"stepId":"step//input.js//multiply"}}}}*/;
export const multiply = async (a, b) => {
    return a * b;
};
registerStepFunction("step//input.js//multiply", multiply);
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
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
export async function myWorkflow(data) {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
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
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//input.js//example"}}},"steps":{"input.js":{"innerStep":{"stepId":"step//input.js//innerStep"}}}}*/;
async function example$innerStep(x, y) {
    return x + y;
}
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//input.js//example";
registerStepFunction("step//input.js//example/innerStep", example$innerStep);
```

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
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"}}}}*/;
var wrapper$_anonymousStep0 = async () => {
    const { multiplier } = __private_getClosureVars();
    return 10 * multiplier;
};
function wrapper(multiplier) {
    return wrapper$_anonymousStep0;
}
registerStepFunction("step//input.js//wrapper/_anonymousStep0", wrapper$_anonymousStep0);
```

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
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"},"subtract":{"stepId":"step//input.js//subtract"}}}}*/;
export async function add(a, b) {
    return a + b;
}
export async function subtract(a, b) {
    return a - b;
}
registerStepFunction("step//input.js//add", add);
registerStepFunction("step//input.js//subtract", subtract);
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
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
export var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//add");
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
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
export async function myWorkflow(data) {
    const result = await fetchData(data);
    return result;
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
globalThis.__private_workflows.set("workflow//input.js//myWorkflow", myWorkflow);
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
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}},"steps":{"input.js":{"increment":{"stepId":"step//input.js//increment"}}}}*/;
export async function myWorkflow(config) {
    let count = 0;
    var increment = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//myWorkflow/increment", () => ({
        count
    }));
    return await increment();
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
globalThis.__private_workflows.set("workflow//input.js//myWorkflow", myWorkflow);
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
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//input.js//add"}}}}*/;
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
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
export async function myWorkflow(data) {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
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
/**__internal_workflows{"classes":{"input.js":{"Point":{"classId":"class//input.js//Point"}}}}*/;
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
registerSerializationClass("class//input.js//Point", Point);
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
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//input.js//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//input.js//MyService"}}}}*/;
export class MyService {
    static async process(data) {
        return data.value * 2;
    }
}
registerStepFunction("step//input.js//MyService.process", MyService.process);
registerSerializationClass("class//input.js//MyService", MyService);
```

Output (Workflow Mode):
```javascript
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//input.js//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//input.js//MyService"}}}}*/;
export class MyService {
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//MyService.process");
registerSerializationClass("class//input.js//MyService", MyService);
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
/**__internal_workflows{"workflows":{"input.js":{"JobRunner.runJob":{"workflowId":"workflow//input.js//JobRunner.runJob"}}}}*/;
export class JobRunner {
    static async runJob(jobId) {
        return await processJob(jobId);
    }
}
JobRunner.runJob.workflowId = "workflow//input.js//JobRunner.runJob";
globalThis.__private_workflows.set("workflow//input.js//JobRunner.runJob", JobRunner.runJob);
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
/**__internal_workflows{"classes":{"input.js":{"Point":{"classId":"class//input.js//Point"}}}}*/;
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
registerSerializationClass("class//input.js//Point", Point);
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
/**__internal_workflows{"classes":{"input.js":{"Bash":{"classId":"class//input.js//Bash"}}}}*/;
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
registerSerializationClass("class//input.js//Bash", Bash);
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
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//default"}}}}*/;
const __default = async (data) => {
    return await process(data);
};
__default.workflowId = "workflow//input.js//default";
globalThis.__private_workflows.set("workflow//input.js//default", __default);
export default __default;
```

---

## Validation Errors

The plugin emits errors for invalid usage:

| Error | Description |
|-------|-------------|
| Non-async function | Functions with `"use step"` or `"use workflow"` must be async |
| Instance methods | Only static methods can have directives (not instance methods) |
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
- `static async method() { "use step"; }` - Static class method

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
