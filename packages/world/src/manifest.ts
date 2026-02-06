/**
 * The workflow manifest contains metadata about all workflows, steps, and classes
 * discovered during the build process. It includes workflow IDs, step IDs,
 * class IDs, and optionally workflow graph data for visualization.
 *
 * The manifest is created during the build process and can be retrieved
 * via the World interface's `manifest.get()` method.
 */
export interface WorkflowManifestData {
  version: string;
  steps: Record<
    string,
    Record<
      string,
      {
        stepId: string;
      }
    >
  >;
  workflows: Record<
    string,
    Record<
      string,
      {
        workflowId: string;
        graph?: {
          nodes: Array<{
            id: string;
            type: string;
            data: {
              label: string;
              nodeKind: string;
              stepId?: string;
            };
            metadata?: Record<string, unknown>;
          }>;
          edges: Array<{
            id: string;
            source: string;
            target: string;
            type?: string;
          }>;
        };
      }
    >
  >;
  classes?: Record<
    string,
    Record<
      string,
      {
        classId: string;
      }
    >
  >;
}
