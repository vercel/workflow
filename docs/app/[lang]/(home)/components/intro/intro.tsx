import { CodeBlock } from '@/app/[lang]/(home)/components/code-block';
import { IntroTabs } from './intro-tabs';
import { NonWorkflowExample } from './non-workflow';
import { WorkflowExample } from './workflow';

const workflowCode = `export async function welcome(userId: string) {
  "use workflow";
  const user = await getUser(userId);
  const { subject, body } = await generateEmail({
    name: user.name, plan: user.plan
  });
  const { status } = await sendEmail({
    to: user.email,
    subject,
    body,
  });
  return { status, subject, body };
}`;

const nonWorkflowCode = `export async function welcome(userId: string) {

  const user = await getUser(userId);
  const { subject, body } = await generateEmail({
    name: user.name, plan: user.plan
  });
  const { status } = await sendEmail({
    to: user.email,
    subject,
    body,
  });
  return { status, subject, body };
}`;

const workflowLogs = [
  // Line 1 (getUser): 3s total
  {
    duration: 500,
    text: 'Queueing the getUser step...',
  },
  {
    duration: 2500,
    text: 'Running the getUser step...',
  },
  {
    duration: 1000,
    text: 'getUser step succeeded. logging telemetry...',
  },
  // 2s delay then Line 2 (generateEmail): 3s
  {
    duration: 1000,
    text: 'Queueing the generateEmail step...',
  },
  {
    duration: 3000,
    text: 'Running the generateEmail step...',
  },
  {
    duration: 1000,
    text: 'generateEmail step succeeded. logging telemetry...',
  },
  // 2s delay then Line 3 (sendEmail): 3s → error
  {
    duration: 1000,
    text: 'Queueing the sendEmail step...',
  },
  {
    duration: 3000,
    text: 'Running the sendEmail step...',
  },
  {
    duration: 1000,
    text: 'sendEmail step failed, retrying...',
  },
  // 1s wait, then show "Retrying..." for 1s
  {
    duration: 2000,
    text: 'Retrying...',
  },
  // 2s delay then Line 3 retry: 4s → success
  {
    duration: 1000,
    text: 'Queueing the sendEmail step...',
  },
  {
    duration: 2500,
    text: 'Running the sendEmail step...',
  },
  {
    duration: 1000,
    text: 'sendEmail step succeeded. logging telemetry...',
  },
  {
    duration: 1000,
    text: 'Workflow completed. logging telemetry...',
  },
];

const nonWorkflowLogs = [
  // Line 1 (getUser): 3s total
  {
    duration: 3000,
    text: 'Calling getUser directly...',
  },
  {
    duration: 2000,
    text: 'getUser completed.',
  },
  // 2s delay then Line 2 (generateEmail): 3s
  {
    duration: 1000,
    text: 'Calling generateEmail directly...',
  },
  {
    duration: 2000,
    text: 'Waiting for LLM response...',
  },
  {
    duration: 1500,
    text: 'generateEmail timed out, process failed.',
  },
];

export const Intro = async () => {
  const codeBlockClassname =
    'shadow-none border-x-0 border-t-0 dark:bg-sidebar with-line-numbers with-checks';

  const workflowCodeBlock = (
    <CodeBlock
      code={workflowCode}
      lang="ts"
      codeblock={{
        className: `shadow-none overflow-visible !bg-background border-b-0! ${codeBlockClassname}`,
      }}
    />
  );
  const nonWorkflowCodeBlock = (
    <CodeBlock
      code={nonWorkflowCode}
      lang="ts"
      codeblock={{
        className: `shadow-none overflow-visible !bg-background border-b-0! ${codeBlockClassname} max-h-[310px]`,
      }}
    />
  );

  return (
    <div className="grid grid-cols-12 gap-y-12 md:gap-x-8 py-8 sm:py-12">
      <div className="col-span-12 md:col-span-5 flex flex-col gap-2">
        <h2 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40">
          Reliability-as-code
        </h2>
        <p className="text-lg text-muted-foreground md:mt-4">
          Move from hand-rolled queues and custom retries to durable, resumable
          code with simple directives.
        </p>
      </div>
      <div className="col-span-12 md:col-span-7 flex items-center justify-center">
        <IntroTabs
          withWorkflow={
            <WorkflowExample
              codeBlock={workflowCodeBlock}
              logs={workflowLogs}
            />
          }
          withoutWorkflow={
            <NonWorkflowExample
              codeBlock={nonWorkflowCodeBlock}
              logs={nonWorkflowLogs}
            />
          }
        />
      </div>
    </div>
  );
};
