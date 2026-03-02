import Image from 'next/image';
import { cn } from '@/lib/utils';
import Flight from './flight.png';
import Storytime from './storytime.png';
import Vectr from './vectr.png';

const data = [
  {
    title: 'Story Generator Slack Bot',
    description:
      "Slackbot that generates children's stories from collaborative input.",
    image: Storytime,
    link: 'https://vercel.com/guides/stateful-slack-bots-with-vercel-workflow',
  },
  {
    title: 'Flight Booking App',
    description:
      'Use Workflow to make AI agents more reliable and production-ready.',
    image: Flight,
    link: 'https://github.com/vercel/workflow-examples/tree/main/flight-booking-app',
  },
  {
    title: 'Natural Language Image Search',
    description:
      'A free, open-source template for building natural language image search.',
    image: Vectr,
    link: 'https://www.vectr.store',
  },
];

export const Templates = () => (
  <div className="p-8 sm:p-12 px-4 py-8 sm:py-12 sm:px-12 grid gap-12">
    <div className="max-w-3xl text-balance grid gap-2">
      <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl lg:text-[40px]">
        Get started quickly
      </h2>
      <p className="text-balance text-lg text-muted-foreground">
        See Workflow DevKit in action with one of our templates.
      </p>
    </div>
    <div className="grid md:grid-cols-3 gap-8">
      {data.map((item) => (
        <a
          key={item.title}
          href={item.link}
          className="flex-col bg-background group rounded-lg border p-4 overflow-hidden"
        >
          <h3 className="font-medium tracking-tight">{item.title}</h3>
          <p className="text-muted-foreground text-sm line-clamp-2">
            {item.description}
          </p>
          <Image
            src={item.image}
            alt={item.title}
            width={640}
            height={336}
            className={cn(
              'border rounded-md overflow-hidden -rotate-3 ml-7 aspect-video object-cover object-top -mb-12 mt-8',
              'group-hover:scale-105 transition-transform duration-300 group-hover:-rotate-1'
            )}
          />
        </a>
      ))}
    </div>
  </div>
);
