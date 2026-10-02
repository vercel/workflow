// `~` is reserved for generated step names, so a step property key can't use it.
export async function wf() {
  "use workflow";
  const helpers = {
    "act~1": async () => {
      "use step";
      return 1;
    },
  };
  return await helpers["act~1"]();
}
