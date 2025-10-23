# Workflow directives specification

The 'use step' and 'use workflow' directives works similarly to the 'use server' in react. A function marked with 'use step' will be bundled and executed on the server. A function marked as 'use workflow' will also be bundled and executed on the server in an alternate v8 runtime.

The swc plugin has 3 modes - 'step' mode, 'workflow' mode, and 'client' mode

## Step Mode

When executed in 'step' mode, step definitions is kept as is and are simply registered using `registerStepFunction` from `@workflow/core/private`. The directives are removed. For example:

Input code:

```
export async function add(a, b) {
  "use step";
  return a + b
}
```

Output code

```
import { registerStepFunction } from "@workflow/core/private"

export async function add(a, b) {
  return a + b
}
registerStepFunction(add)
```

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
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add")(a, b);
}
```

Workflow definitions are left untouched in workflow mode, aside from the directive itself being removed.

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
```

Upstream, a bundler will use this plugin in workflow mode to create a server bundle of all the workflows and serve it via an API endpoint at `.well-known/workflow/v1/flow`. The workflow endpoint handler encapsulates logic to execute the correct workflow using the function name, which is why nothing needs to be done to the workflows themselves. They just need to be exported.

## Client Mode

When executed in 'client' mode, step and workflow definitions have their bodies replaced with a call to `runStep` and `start` respectively. Both these helper functions are exported from the `@workflow/core` package. They effectively proxy the requests to execute steps and workflows on the server (using the bundles created in the other two modes).

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
import { start as __private_workflow_start, runStep as __private_run_step } from "@workflow/core/runtime"

export async function add(a, b) {
  return __private_run_step('add', { arguments: [a, b] })
}

export async function workflow(a, b) {
  return __private_workflow_start('workflow', [a, b])
}
```

Upstream, this mode is typically used by a framework loader (like a NextJS/webpack loader) to JIT transform workflow executions into proxied start calls.

## Notes

* Instead of individually marking functions with 'use step' or 'use_workflow', you can also add the directive to the top of a file to mark all exports within that file as step functions or workflows
* the directives must be at the very beginning of their function or module; above any other code including imports (comments above directives are OK). They must be written with single or double quotes, not backticks.
* The arguments and return value of 'use step' and 'use workflow' must be serializable.
* Because the underlying network calls are always asynchronous, 'use step' and 'use workflow' can only be used on async functions.
