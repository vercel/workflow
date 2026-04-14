import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

const BLOB_URL = 'https://lishhsx6kmthaacj.public.blob.vercel-storage.com';

type Tweet = {
  url: string;
  name: string;
  username: string;
  image: string;
  tweet: ReactNode;
};

const TWEETS: Tweet[] = [
  // Left column (indices 0-2)
  {
    url: 'https://x.com/resend/status/1981494746347630976',
    name: 'Resend',
    username: 'resend',
    image: `${BLOB_URL}/resend.jpg`,
    tweet: (
      <>
        <span>
          Resend + <InlineLink>@vercel</InlineLink> Workflow Dev Kit
        </span>
        <span>A match made in heaven</span>
      </>
    ),
  },
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
        <span aria-label="exploding_head" role="img">
          🤯
        </span>
      </>
    ),
  },
  // Middle column (indices 3-5)
  {
    url: 'https://x.com/ryancarson/status/1999857760335192159',
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
  {
    url: 'https://x.com/kumareth/status/1981434879805194265',
    name: 'Kumar Abhirup',
    username: 'kumareth',
    image: `${BLOB_URL}/kumareth.jpg`,
    tweet: (
      <>
        <span>
          Vercel&apos;s <InlineCode>use workflow</InlineCode> is game changing.
        </span>
        <span>
          Temporal existed for years, but AI Agents are what brought the
          critical demand for durable execution.
        </span>
      </>
    ),
  },
  // Right column (indices 6-8)
  {
    url: 'https://x.com/nikitabase/status/1982509352486682854',
    name: 'Nikita | Scaling Postgres',
    username: 'nikitabase',
    image: `${BLOB_URL}/nikitabase.jpg`,
    tweet: (
      <span>
        <InlineCode>use workflow</InlineCode> is beautiful
      </span>
    ),
  },
  {
    url: 'https://x.com/YashSolanki_/status/1992131148823040327',
    name: 'Yash Solanki',
    username: 'YashSolanki_',
    image: `${BLOB_URL}/YashSolanki_.jpg`,
    tweet: (
      <>
        <span>
          If you&apos;re building any agentic workflow, then you should
          definitely watch this.
        </span>
        <span>
          I feel like using workflow will become the go-to choice for your
          projects.
        </span>
        <span>
          Whether it&apos;s a side project or complex agentic flows,{' '}
          <InlineCode>use workflow</InlineCode> by{' '}
          <InlineLink>@vercel</InlineLink> just makes so much sense now.
        </span>
        <span>
          Love that the logs screen makes it easier to see what&apos;s going.
        </span>
      </>
    ),
  },
  {
    url: 'https://x.com/eersnington/status/1982225225010782715',
    name: 'Sree',
    username: 'eersnington',
    image: `${BLOB_URL}/eersnington.jpg`,
    tweet: (
      <>
        <span>vercel has the vibe as apple during steve jobs era</span>
        <span>
          durable workflows aren&apos;t anything new (and a massive headache to
          roll your own too), but vercel isn&apos;t afraid of doing things
          differently and reinvent them in a way that feels clean and effortless
        </span>
        <span>this is really exciting to me</span>
      </>
    ),
  },
];

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="border border-border bg-accent inline-block px-1 py-px rounded text-[13px] font-mono">
      {children}
    </code>
  );
}

function InlineLink({ children }: { children: ReactNode }) {
  return <span className="text-blue-700">{children}</span>;
}

function VerifiedBadge() {
  return (
    <svg
      viewBox="0 0 22 22"
      aria-label="Verified account"
      role="img"
      className="fill-[rgb(29,155,240)] size-4"
    >
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

function TweetCard({ url, name, username, image, tweet }: Tweet) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-3 rounded-lg border p-4 md:p-5 hover:border-foreground/20 transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <Avatar className="size-9">
          <AvatarImage src={image} alt={name} />
          <AvatarFallback>{name[0]}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col">
          <span className="text-sm font-medium flex items-center gap-1">
            {name}
            <VerifiedBadge />
          </span>
          <span className="text-sm text-muted-foreground">@{username}</span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed flex flex-col gap-2.5">
        {tweet}
      </p>
    </a>
  );
}

export const TweetWall = () => (
  <div className="p-8 sm:p-12 px-4 py-8 sm:py-12 sm:px-12 grid gap-8">
    <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl lg:text-[40px] text-center text-balance">
      What builders say about Workflow SDK
    </h2>
    <div className="columns-1 gap-4 space-y-4 md:columns-2 lg:columns-3">
      {TWEETS.map((tweet) => (
        <div key={tweet.username} className="break-inside-avoid">
          <TweetCard {...tweet} />
        </div>
      ))}
    </div>
  </div>
);
