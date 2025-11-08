# Workflow directives specification

The 'use step' and 'use workflow' directives works similarly to the 'use server' in react. A function marked with 'use step' will be bundled and executed on the server. A function marked as 'use workflow' will also be bundled and executed on the server in an alternate v8 runtime.

The swc plugin has 3 modes - 'step' mode, 'workflow' mode, and 'client' mode

## Step Mode

When executed in 'step' mode, step definitions is kept as is and are simply registered using `registerStepFunction` from `workflow/internal/private`. The directives are removed. For example:

Input code:

```
export async function add(a, b) {
  "use step";
  return a + b
}
```

Output code

```
import { registerStepFunction } from "workflow/internal/private"

export async function add(a, b) {
  return a + b
}
registerStepFunction("step//input.js//add", add)
```

**ID Generation:** Step IDs are generated using the format `step//{filepath}//{functionName}`, where:

- `filepath` is the relative path to the file from the project root
- `functionName` is the name of the step function

Workflow definitions are left untouched in step mode, including leaving the directives intact.

Upstream, a bundler will use this plugin in step mode to create a server bundle of multiple steps and serve it via an API endpoint at `.well-known/workflow/v1/step`

## Workflow Mode

When executed in workflow mode, step definition bodies are replaced with a `useStep` call, which is a function accessible at the global scope via the `Symbol.for("WORKFLOW_USE_STEP")` symbol. `useStep` encapsulates logic to either make a network request to enqueue the step (which is served from the step bundle created in step mode), or resolves the value from the local event log.

Input code

```
export async function add(a, b) {
  "use step";
  return a + b;
}
```

Output code

```
export async function add(a, b) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//add")(a, b);
}
```

**ID Generation:** The same step ID format `step//{filepath}//{functionName}` is used when replacing step function bodies.

Workflow definitions are left untouched in workflow mode, aside from the directive itself being removed and a `workflowId` property being attached.

Input code

```
export async function example(a, b) {
  "use workflow";
  return a + b;
}
```

Output code

```
export async function example(a, b) {
  return a + b;
}
example.workflowId = "workflow//input.js//example";
```

**ID Generation:** Workflow IDs are generated using the format `workflow//{filepath}//{functionName}` and attached as a property to the function.

Upstream, a bundler will use this plugin in workflow mode to create a server bundle of all the workflows and serve it via an API endpoint at `.well-known/workflow/v1/flow`. The workflow endpoint handler encapsulates logic to execute the correct workflow using the function name, which is why nothing needs to be done to the workflows themselves. They just need to be exported.

## Client Mode

When executed in 'client' mode, step definitions have their `"use step"` directive removed while keeping their implementation intact. This allows step functions to be called directly from server code (e.g., from a Next.js server route) and execute as regular functions. Workflow functions have the `workflowId` property attached and will throw an error if called directly.

Input code

```
// workflow/main.js
export async function add(a, b) {
  "use step";
  return a + b;
}

export async function workflow(a, b) {
  "use workflow";
  return add(a, b);
}
```

Output code

```
// workflow/main.js
export async function add(a, b) {
  return a + b;
}

export async function workflow(a, b) {
  throw new Error("You attempted to execute workflow workflow function directly. To start a workflow, use start(workflow) from workflow/api");
}
workflow.workflowId = "workflow//workflow/main.js//workflow";
```

**ID Generation:**

- Step functions keep their implementation intact (directive is removed)
- Workflow functions throw an error if called directly and have the `workflowId` property attached using the format `workflow//{filepath}//{functionName}`

Upstream, this mode is typically used by a framework loader (like a Next.js/webpack/Vite loader) to transform application code. Step functions can be called directly from server code and will execute normally, allowing them to be reused in different contexts. Workflow functions must be started using the `start()` API from `workflow/api`.

## Notes

- Instead of individually marking functions with 'use step' or 'use_workflow', you can also add the directive to the top of a file to mark all exports within that file as step functions or workflows
- the directives must be at the very beginning of their function or module; above any other code including imports (comments above directives are OK). They must be written with single or double quotes, not backticks.
- The arguments and return value of 'use step' and 'use workflow' must be serializable.
- Because the underlying network calls are always asynchronous, 'use step' and 'use workflow' can only be used on async functions.
