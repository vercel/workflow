import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import Flight from './flight-v2.png';
import FlightDark from './flight-v2-dark.png';
import Storytime from './storytime-v2.png';
import StorytimeDark from './storytime-v2-dark.png';
import Vectr from './vectr-v2.png';
import VectrDark from './vectr-v2-dark.png';

const data = [
  {
    title: 'Story Generator Slack Bot',
    description:
      "A Slack bot that generates children's stories from collaborative input.",
    image: Storytime,
    imageDark: StorytimeDark,
    link: 'https://vercel.com/guides/stateful-slack-bots-with-vercel-workflow',
  },
  {
    title: 'Flight Booking App',
    description:
      'Use Workflow to make AI agents more reliable and production-ready.',
    image: Flight,
    imageDark: FlightDark,
    link: 'https://github.com/vercel/workflow-examples/tree/main/flight-booking-app',
  },
  {
    title: 'Natural Language Image Search',
    description:
      'A free, open-source template for building natural language image search.',
    image: Vectr,
    imageDark: VectrDark,
    link: 'https://www.vectr.store',
  },
];

export const Templates = () => (
  <div className="grid md:grid-cols-[1fr_2fr] md:divide-x">
    <div className="grid gap-4 content-start px-4 py-8 sm:py-12 sm:px-12">
      <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl lg:text-[40px]">
        Get started
      </h2>
      <p className="text-lg text-muted-foreground">
        See Workflow SDK in action with one of the example templates.
      </p>
      <Button asChild size="lg" className="rounded-full h-10 px-6 w-fit mt-2">
        <Link href="/docs/examples">All examples</Link>
      </Button>
    </div>
    <div className="grid sm:grid-cols-2 gap-8 px-4 py-8 sm:py-12 sm:px-12">
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
              'group-hover:scale-105 transition-transform duration-300 group-hover:-rotate-1',
              'dark:hidden'
            )}
          />
          <Image
            src={item.imageDark}
            alt={item.title}
            width={640}
            height={336}
            className={cn(
              'border rounded-md overflow-hidden -rotate-3 ml-7 aspect-video object-cover object-top -mb-12 mt-8',
              'group-hover:scale-105 transition-transform duration-300 group-hover:-rotate-1',
              'hidden dark:block'
            )}
          />
        </a>
      ))}
    </div>
  </div>
);
