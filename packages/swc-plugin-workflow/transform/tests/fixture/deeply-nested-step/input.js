import { createConfig } from "some-library";

// Test deeply nested step functions (4 levels deep)
export const config = createConfig({
  level1: {
    level2: {
      level3: {
        myStep: async (input) => {
          "use step";
          return input * 2;
        },
      },
    },
  },
});
