// A step nested inside a step body is only seen by step mode. It shares the
// `foo/x` namespace with a step nested in a workflow's helper `foo`, which both
// modes see, so it must not take that step's ID.
export async function foo() {
  "use step";
  const x = async () => {
    "use step";
    return "inside step";
  };
  return await x();
}

export async function wf() {
  "use workflow";
  function foo() {
    const x = async () => {
      "use step";
      return "inside workflow helper";
    };
    return x;
  }
  return await foo()();
}
