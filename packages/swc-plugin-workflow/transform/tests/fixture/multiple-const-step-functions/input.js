const fn1 = async () => {
  'use step';
  return 1;
}, fn2 = async () => {
  'use step';
  return 2;
};

export const fn3 = async () => {
  'use step';
  return 3;
}, fn4 = async () => {
  'use step';
  return 4;
};

// Test case: regular function BEFORE step function in same declaration
// This verifies that processing doesn't skip the step function
const regularArrow = () => 1, stepAfterRegular = async () => {
  'use step';
  return 5;
};

// Test case: regular function expression BEFORE step function
const regularFn = function() { return 2; }, stepAfterRegularFn = async function() {
  'use step';
  return 6;
};

