// Regression test: non-exported workflow functions in three different
// declaration shapes must each emit a step ID that is namespaced under
// the workflow function's name, and step mode and workflow mode must
// agree on that ID. Without the fix, only `async function fnDecl()`
// produced a namespaced ID; the `const constArrow = async () => {}` and
// `const constFnExpr = async function() {}` shapes produced bare IDs in
// step mode while workflow mode looked them up under the workflow name,
// causing a runtime "step not found" failure.

// 1. async function declaration
async function fnDecl() {
  'use workflow';
  const agent = new WorkflowAgent({
    tools: () => ({
      a: { execute: async () => { 'use step'; return 1; } },
    }),
  });
}

// 2. const arrow expression
const constArrow = async () => {
  'use workflow';
  const agent = new WorkflowAgent({
    tools: () => ({
      b: { execute: async () => { 'use step'; return 2; } },
    }),
  });
};

// 3. const function expression
const constFnExpr = async function () {
  'use workflow';
  const agent = new WorkflowAgent({
    tools: () => ({
      c: { execute: async () => { 'use step'; return 3; } },
    }),
  });
};
