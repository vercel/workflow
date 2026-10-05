// `~` is allowed in object step keys. `~N` is also the generated collision
// suffix, so names are claimed in source order with the smallest free `~N`.

// A standalone "act~1" keeps its name.
export async function standalone() {
  "use workflow";
  const helpers = {
    "act~1": async () => {
      "use step";
      return "standalone";
    },
  };
  return await helpers["act~1"]();
}

// Explicit "act~1" before two `act`: act~1, act, act~2.
export async function explicitFirst(op) {
  "use workflow";
  if (op === 0) {
    const helpers = {
      "act~1": async () => {
        "use step";
        return "explicit";
      },
    };
    return await helpers["act~1"]();
  } else if (op === 1) {
    const helpers = {
      act: async () => {
        "use step";
        return "first act";
      },
    };
    return await helpers.act();
  } else {
    const helpers = {
      act: async () => {
        "use step";
        return "second act";
      },
    };
    return await helpers.act();
  }
}

// Explicit "act~1" after two `act`: act, act~1, act~1~1.
export async function explicitLast(op) {
  "use workflow";
  if (op === 0) {
    const helpers = {
      act: async () => {
        "use step";
        return "first act";
      },
    };
    return await helpers.act();
  } else if (op === 1) {
    const helpers = {
      act: async () => {
        "use step";
        return "second act";
      },
    };
    return await helpers.act();
  } else {
    const helpers = {
      "act~1": async () => {
        "use step";
        return "explicit";
      },
    };
    return await helpers["act~1"]();
  }
}

// Keys that sanitize to the same identifier still get distinct bindings.
export const keys = {
  "act~1": async () => {
    "use step";
    return "tilde";
  },
  act_1: async () => {
    "use step";
    return "underscore";
  },
  "act-1": async () => {
    "use step";
    return "dash";
  },
};

// Getter steps named "act~1" and act_1 get distinct proxy bindings.
export async function getters() {
  "use workflow";
  const obj = {
    get "act~1"() {
      "use step";
      return "tilde getter";
    },
    get act_1() {
      "use step";
      return "underscore getter";
    },
  };
  return obj["act~1"] + obj.act_1;
}
