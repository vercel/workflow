// Steps with the same local name in different block scopes are distinct
// functions and must get distinct hoisted bindings and step IDs.

// Unrelated names elsewhere in the file don't affect generated suffixes.
const unrelated = { act$1: true, "act~1": true };
export async function collisionWorkflow(operation, requestId) {
  "use workflow";

  if (operation === "validate") {
    const act = async (id) => {
      "use step";
      return `validated:${id}`;
    };
    return await act(requestId);
  } else {
    const act = async (id) => {
      "use step";
      return `approved:${id}`;
    };
    return await act(requestId);
  }
}

export async function fnDeclWorkflow(operation) {
  "use workflow";

  if (operation === "a") {
    async function act() {
      "use step";
      return "a";
    }
    return await act();
  }
  {
    async function act() {
      "use step";
      return "b";
    }
    return await act();
  }
}

export async function objectWorkflow(operation) {
  "use workflow";

  if (operation === "a") {
    const helpers = {
      async act() {
        "use step";
        return "a";
      },
    };
    return await helpers.act();
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

// A user-declared step named `act$1` doesn't affect the generated `act~1`
// step ID; only the hoisted bindings are renamed to stay unique.
export async function suffixWorkflow(operation) {
  "use workflow";

  if (operation === "a") {
    const act = async () => {
      "use step";
      return "a";
    };
    return await act();
  } else if (operation === "b") {
    const act$1 = async () => {
      "use step";
      return "b";
    };
    return await act$1();
  } else {
    const act = async () => {
      "use step";
      return "c";
    };
    return await act();
  }
}

// An explicitly named step declared after the duplicates keeps its own name
// and ID regardless of source order.
export async function reservedSuffixWorkflow(operation) {
  "use workflow";

  if (operation === "a") {
    const act = async () => {
      "use step";
      return "a";
    };
    return await act();
  } else if (operation === "b") {
    const act = async () => {
      "use step";
      return "b";
    };
    return await act();
  } else {
    const act$1 = async () => {
      "use step";
      return "privileged";
    };
    return await act$1();
  }
}
