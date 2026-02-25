import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

export const TweetWall = (): JSX.Element => (
  <section className="px-4 sm:px-12 py-10 md:py-16">
    <p className="font-semibold text-2xl md:text-3xl lg:text-4xl tracking-tight text-center text-balance mb-6 md:mb-10">
      What builders say about Workflow DevKit
    </p>
    <div className="columns-1 gap-4 space-y-4 md:columns-2 lg:columns-3">
      {TWEETS.map((tweet) => (
        <div key={tweet.username} className="break-inside-avoid">
          <Tweet {...tweet} />
        </div>
      ))}
    </div>
  </section>
);

type TweetProps = {
  image: string;
  name: string;
  tweet: string | React.ReactNode;
  url: string;
  username: string;
};

function Tweet({ image, name, tweet, url, username }: TweetProps): JSX.Element {
  return (
    <a
      className="p-4 md:p-5 gap-3 flex flex-col rounded-lg border bg-card no-underline transition-colors hover:bg-accent/50"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="flex items-center gap-2.5">
        <Avatar className="size-9">
          <AvatarImage src={image} alt={name} />
          <AvatarFallback>
            {name
              .split(' ')
              .map((n) => n[0])
              .join('')}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col items-start">
          <span className="text-sm font-medium flex items-center gap-1">
            {name}
            <svg
              viewBox="0 0 22 22"
              aria-label="Verified account"
              role="img"
              className="fill-[rgb(29,155,240)] size-4"
            >
              <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
            </svg>
          </span>
          <span className="text-sm text-muted-foreground">@{username}</span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground text-balance leading-relaxed flex flex-col gap-2.5">
        {tweet}
      </p>
    </a>
  );
}

function InlineCode({
  className,
  ...props
}: React.ComponentProps<'code'>): JSX.Element {
  return (
    <code
      className={cn(
        'border border-border inline-block',
        'bg-accent px-1 py-px rounded text-xs font-mono',
        className
      )}
      {...props}
    />
  );
}

function InlineLink({
  className,
  ...props
}: React.ComponentProps<'span'>): JSX.Element {
  return (
    <span className={cn('text-[rgb(29,155,240)]', className)} {...props} />
  );
}

const BLOB_URL = 'https://lishhsx6kmthaacj.public.blob.vercel-storage.com';

const TWEETS: TweetProps[] = [
  {
    url: 'https://x.com/michaelcaaarter/status/1986078356325187762',
    name: 'Michael Carter',
    username: 'michaelcaaarter',
    image: `${BLOB_URL}/michaelcaaarter.jpg`,
    tweet: (
      <span>
        We just migrated to <InlineCode>use workflow</InlineCode> and it&apos;s
        beautiful. Production app here, VC backed and many real fortune 100
        customers using our app daily… not sure why you wouldn&apos;t{' '}
        <InlineCode>use workflow</InlineCode> to move fast and focus on building
        a great experience.
      </span>
    ),
  },
  {
    url: 'https://x.com/nick_tikhonov/status/1985971284577050699',
    name: 'Nick Tikhonov',
    username: 'nick_tikhonov',
    image: `${BLOB_URL}/nick_tikhonov.jpg`,
    tweet: (
      <>
        <span>
          fully migrated to workflows - our use case are AI agents that execute
          over a multiple-day time frame, making multiple outbound voice calls
          and processing the results
        </span>
        <span>
          before: <br />- scheduling service <br />- queues <br />- workers{' '}
          <br />- cron jobs
        </span>
        <span>now: - 5 functions in one file</span>
      </>
    ),
  },
  {
    url: 'https://x.com/karthikkalyan90/status/1981793765871534588',
    name: 'Karthik Kalyan',
    username: 'karthikkalyan90',
    image: `${BLOB_URL}/karthikkalyan90.jpg`,
    tweet: (
      <>
        <span>
          Behind the elegant and seemingly simple looking{' '}
          <InlineCode>use workflow</InlineCode> and{' '}
          <InlineCode>use step</InlineCode> directives of the new workflow
          development kit from <InlineLink>@vercel</InlineLink> lies a bunch of
          compiler engineering. I was curious and decided to dive deeper into
          the open source code. Buckle up and read this post if you are curious
          too.
        </span>
        <span>
          The workflow development kit (WDK) from Vercel is a new piece of
          developer infrastructure that lets developers write workflows and
          durable functions.{' '}
        </span>
        <span>
          Durable functions are stateful workflows in a serverless environment.
          Ordinary functions are stateless: once they finish, their context
          disappears. But a durable function can be paused (suspended) while
          waiting for an external event or timer, and later resumed from exactly
          where it left off with full context preserved.
        </span>
        <span>
          If you are building something that requires maintaining the state, you
          would typically need to store the state in a database and maintain all
          the baggage that comes with it. WDK aims to make this part easier.
        </span>
      </>
    ),
  },
  {
    url: 'https://x.com/ryancarson/status/1996318671749120315',
    name: 'Ryan Carson',
    username: 'ryancarson',
    image: `${BLOB_URL}/ryancarson.jpg`,
    tweet: (
      <>
        <span>What a time to be a content marketer.</span>
        <span>Sheesh this is mind-blowing.</span>
        <span>
          Built a complete end-to-end workflow with{' '}
          <InlineLink>@ampcode</InlineLink> using{' '}
          <InlineLink>@WorkflowDevKit</InlineLink> and{' '}
          <InlineLink>@vercel</InlineLink> AI Gateway
        </span>
        <span>
          - Custom DurableAgent tools for research <br />- Opus 4.5 for
          generation <br />- Gemini 3 Pro for content verification
          <br />- Nano Banana for image creation
        </span>
        <span>AEO locked in.</span>
      </>
    ),
  },
  {
    url: 'https://x.com/ale__vigano/status/1993822442616213851',
    name: 'Ale Vigano',
    username: 'ale__vigano',
    image: `${BLOB_URL}/ale__vigano.jpg`,
    tweet: (
      <>
        <span>
          During my time at <InlineLink>@mercadopago</InlineLink> we struggled a
          lot with concurrency issues handling millions of payments.
        </span>
        <span>
          Hard to believe that almost all the complexity I remember from back
          then is now solved with just a <InlineCode>use workflow</InlineCode>
        </span>
      </>
    ),
  },
];
