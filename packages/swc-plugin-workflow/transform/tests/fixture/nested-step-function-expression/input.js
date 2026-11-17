// A `"use step"` function expression bound to a const inside a function is a
// nested step, like the arrow form: hoisted, namespaced by the enclosing
// function, and given the closure variables it captures.
export async function closureSteps(n, label) {
  'use workflow';

  const named = async function summarize() {
    'use step';
    return `${label}:${n + 1}`;
  };

  const anonymous = async function () {
    'use step';
    return n * 2;
  };

  return [await named(), await anonymous()];
}

function stepWrapperReturnNamedFunctionExprVar(a, b) {
  const fn = async function inner() {
    'use step';
    return a + b;
  };
  return fn;
}

export async function usesWrapper() {
  'use workflow';
  return stepWrapperReturnNamedFunctionExprVar(1, 2)();
}

// At module level it stays a module-level step.
const moduleLevel = async function () {
  'use step';
  return 1;
};

export async function usesModuleLevel() {
  'use workflow';
  return moduleLevel();
}
