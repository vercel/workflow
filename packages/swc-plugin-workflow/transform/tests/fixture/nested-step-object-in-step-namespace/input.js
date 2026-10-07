// An object property step inside a step body is only seen by step mode. It
// shares the `helpers/act` namespace with the module-level `helpers.act` step,
// which both modes see, so the two modes must agree on which body is which.
export async function foo() {
  "use step";
  const helpers = {
    act: async () => {
      "use step";
      return "inside step";
    },
  };
  return await helpers.act();
}

export const helpers = {
  act: async () => {
    "use step";
    return "module object";
  },
};
