export async function example(a, b) {
  "use workflow";

  // Function declaration step
  async function step(a, b) {
    "use step";

    return a + b;
  }

  // Arrow function with const
  const arrowStep = async (x, y) => {
    "use step";
    return x * y;
  };

  // Arrow function with let
  let letArrowStep = async (x, y) => {
    "use step";
    return x - y;
  };

  // Arrow function with var
  var varArrowStep = async (x, y) => {
    "use step";
    return x / y;
  };

  // Object with step method
  const helpers = {
    async objectStep(x, y) {
      "use step";
      return x + y + 10;
    }
  };

  const val = await step(a, b);
  const val2 = await arrowStep(a, b);
  const val3 = await letArrowStep(a, b);
  const val4 = await varArrowStep(a, b);
  const val5 = await helpers.objectStep(a, b);

  return val + val2 + val3 + val4 + val5;
}
