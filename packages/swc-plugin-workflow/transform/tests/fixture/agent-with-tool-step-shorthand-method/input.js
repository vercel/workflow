import { agent } from "experimental-agent";

export const vade = agent({
  tools: {
    VercelRequest: {
      async execute(input, { experimental_context }) {
        "use step";
        return 1+1
      },
    },
  },
});
