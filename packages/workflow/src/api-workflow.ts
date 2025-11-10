export type {
  Event,
  StartOptions,
  WorkflowReadableStreamOptions,
  WorkflowRun,
} from '@workflow/core/runtime';

const workflowStub = (item: string) => {
  throw new Error(
    `The workflow environment doesn't allow this runtime usage of ${item}.`
  );
};

export function Run() {
  workflowStub('Run');
}
export const getRun = () => workflowStub('getRun');
export const getHookByToken = () => workflowStub('getHookByToken');
export const resumeHook = () => workflowStub('resumeHook');
export const resumeWebhook = () => workflowStub('resumeWebhook');
export const runStep = () => workflowStub('runStep');
export const start = () => workflowStub('start');
