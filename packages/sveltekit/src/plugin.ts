import type { HotUpdateOptions, Plugin } from "vite";
import { SvelteKitBuilder } from "./builder.js";
import { workflowTransformPlugin } from "@workflow/rollup";

export function workflowPlugin(): Plugin[] {
  let builder: SvelteKitBuilder;

  // Build queue to serialize builds and prevent race conditions
  // when rapid file changes trigger concurrent hotUpdate calls.
  // This follows the same pattern as packages/next/src/builder.ts.
  let buildQueue = Promise.resolve();

  const enqueueBuild = (task: () => Promise<void>): Promise<void> => {
    buildQueue = buildQueue.then(task).catch((error) => {
      console.error("Workflow build failed:", error);
    });
    return buildQueue;
  };

  return [
    workflowTransformPlugin(),
    {
      name: "workflow:sveltekit",
      configResolved() {
        builder = new SvelteKitBuilder();
      },

      // TODO: Move this to @workflow/vite or something since this is vite specific
      async hotUpdate(options: HotUpdateOptions) {
        const { file, server, read } = options;

        // Check if this is a TS/JS file that might contain workflow directives
        const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
        if (!jsTsRegex.test(file)) {
          return;
        }

        // Read the file to check for workflow/step directives
        let content: string;
        try {
          content = await read();
        } catch {
          // File might have been deleted - trigger rebuild to update generated routes
          console.log("Workflow file deleted, regenerating routes...");
          await enqueueBuild(() => builder.build());
          return;
        }

        const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
        const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

        if (
          !useWorkflowPattern.test(content) &&
          !useStepPattern.test(content)
        ) {
          return;
        }

        // Rebuild everything - simpler and more reliable than tracking individual files
        console.log("Workflow file changed, regenerating routes...");
        await enqueueBuild(() => builder.build());

        // Trigger full reload of workflow routes
        server.ws.send({
          type: "full-reload",
          path: "*",
        });

        // Let Vite handle the normal HMR for the changed file
        return;
      },
    },
  ];
}
