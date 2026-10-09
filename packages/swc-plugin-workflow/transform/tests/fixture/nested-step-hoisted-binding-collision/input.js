// A nested step named `helpers$act` and the object property step `helpers.act`
// have distinct step IDs and would both be hoisted as `wf$helpers$act`, so the
// second binding is renamed.
export async function wf(operation) {
  "use workflow";

  if (operation === "a") {
    const helpers$act = async () => {
      "use step";
      return "a";
    };
    return await helpers$act();
  } else {
    const helpers = {
      act: async () => {
        "use step";
        return "b";
      },
    };
    return await helpers.act();
  }
}
