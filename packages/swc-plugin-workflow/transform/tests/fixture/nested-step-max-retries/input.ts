export async function example(a) {
  "use workflow";

  // Function-declaration step with an explicit retry count set inside the
  // workflow body. The assignment must survive onto the hoisted step.
  async function fnStep(x) {
    "use step";
    return x + 1;
  }
  fnStep.maxRetries = 0;

  // Arrow step with a non-default retry count.
  const arrowStep = async (x) => {
    "use step";
    return x * 2;
  };
  arrowStep.maxRetries = 7;

  return (await fnStep(a)) + (await arrowStep(a));
}
