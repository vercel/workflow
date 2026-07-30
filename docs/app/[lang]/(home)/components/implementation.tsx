import { CodeBlock } from '@/app/[lang]/(home)/components/code-block';

const data = [
  {
    code: `import { sleep } from "workflow";
import {
  createUser,
  sendWelcomeEmail,
  sendOneWeekCheckInEmail
} from "./steps"

export async function userSignup(email) {
  "use workflow";

  // Create the user and send the welcome email
  const user = await createUser(email);
  await sendWelcomeEmail(email);

  // Pause for 7 days
  // without consuming any resources
  await sleep("7 days");
  await sendOneWeekCheckInEmail(email);

  return { userId: user.id, status: "done" };
}`,
    caption: 'Creating a workflow',
  },
  {
    code: `import { Resend } from 'resend';
import { FatalError } from 'workflow';

export async function sendWelcomeEmail(email) {
  "use step"

  const resend = new Resend('YOUR_API_KEY');

  const resp = await resend.emails.send({
    from: 'Acme <onboarding@resend.dev>',
    to: [email],
    subject: 'Welcome!',
    html: \`Thanks for joining Acme.\`,
  });

  if (resp.error) {
    throw new FatalError(resp.error.message);
  }
};

// Other steps...`,
    caption: 'Defining steps',
  },
];

export const Implementation = () => (
  <div className="px-4 py-8 sm:py-12 sm:px-6 grid gap-12">
    <div className="max-w-3xl text-balance grid gap-2">
      <h2 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40">
        Effortless setup
      </h2>
      <p className="text-balance text-lg text-muted-foreground">
        With a simple declarative API to define and use your workflows.
      </p>
    </div>
    <div className="grid md:grid-cols-2 gap-6 md:gap-24">
      {data.map((item) => (
        <div
          key={item.caption}
          className="h-full flex flex-col [&_figure]:flex-1 [&_.fd-scroll-container]:h-full gap-4"
        >
          <h3 className="text-heading-16 sm:text-heading-20 md:text-heading-24">
            {item.caption}
          </h3>
          <CodeBlock
            code={item.code}
            lang="ts"
            codeblock={{
              className:
                'shadow-none !bg-background dark:bg-sidebar h-full rounded-md with-line-numbers',
            }}
          />
        </div>
      ))}
    </div>
  </div>
);
