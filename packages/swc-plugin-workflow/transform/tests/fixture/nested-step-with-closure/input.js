import { DurableAgent } from '@workflow/ai/agent';
import { gateway } from 'ai';

function stepWrapperReturnArrowFunctionVar(a, b, c) {
  const fn = async () => {
    'use step';
    return a + b + c;
  };
  return fn;
}

function stepWrapperReturnNamedFunction(a, b, c) {
  return async function f() {
    'use step';
    return a + b + c;
  };
}

function stepWrapperReturnArrowFunction(a, b, c) {
  return async () => {
    'use step';
    return a + b + c;
  };
}

function stepWrapperReturnNamedFunctionVar(a, b, c) {
  async function fn() {
    'use step';
    return a + b + c;
  }
  return fn;
}

const arrowWrapperReturnArrowFunctionVar = (a, b, c) => {
  const fn = async () => {
    'use step';
    return a + b + c;
  };
  return fn;
}

const arrowWrapperReturnNamedFunction = (a, b, c) => {
  return async function f() {
    'use step';
    return a + b + c;
  };
}

const arrowWrapperReturnArrowFunction = (a, b, c) => {
  return async () => {
    'use step';
    return a + b + c;
  };
}

const arrowWrapperReturnNamedFunctionVar = (a, b, c) => {
  async function fn() {
    'use step';
    return a + b + c;
  }
  return fn;
}


export async function wflow() {
  'use workflow';
  let count = 42;

  async function namedStepWithClosureVars() {
    'use step';
    console.log('count', count);
  }

  const agent = new DurableAgent({
    arrowFunctionWithClosureVars: async () => {
      'use step';
      console.log('count', count);
      return gateway('openai/gpt-5');
    },

    namedFunctionWithClosureVars: async function() {
      'use step';
      console.log('count', count);
    },

    async methodWithClosureVars() {
      'use step';
      console.log('count', count);
    },
  });

  await stepWrapperReturnArrowFunctionVar(1, 2, 3)();
  await stepWrapperReturnNamedFunction(1, 2, 3)();
  await stepWrapperReturnArrowFunction(1, 2, 3)();
  await stepWrapperReturnNamedFunctionVar(1, 2, 3)();
  await arrowWrapperReturnArrowFunctionVar(1, 2, 3)();
  await arrowWrapperReturnNamedFunction(1, 2, 3)();
  await arrowWrapperReturnArrowFunction(1, 2, 3)();
  await arrowWrapperReturnNamedFunctionVar(1, 2, 3)();
}
