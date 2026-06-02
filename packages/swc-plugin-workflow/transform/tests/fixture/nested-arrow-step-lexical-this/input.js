// A nested arrow-function step that references `this` from the enclosing
// method. The class is serializable, so the workflow runtime can carry the
// captured `this` across the workflow→step boundary.
//
// The compiler should:
//   - Workflow mode: emit `...WORKFLOW_USE_STEP(...).bind(this)` so the step
//     proxy captures the caller's `this` and forwards it as `thisVal`.
//   - Step mode:    hoist the step body as a regular `function` (not an arrow)
//     so the runtime's `stepFn.apply(thisVal, args)` rebinds `this` inside the
//     hoisted body.
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
