// A step nested in function `helpers` and a step property on object `helpers`
// share the `helpers/act` namespace. Both transform modes must give each body
// the same step ID, whichever is discovered first.
export async function wf() {
  "use workflow";
  function helpers() {
    const act = async () => {
      "use step";
      return "privileged";
    };
    return act;
  }
  return await helpers()();
}

var helpers = {
  act: async () => {
    "use step";
    return "unprivileged";
  },
};
