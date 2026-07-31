import { Button } from '@vercel/geistdocs/components/button';
import Link from 'next/link';
import type { JSX } from 'react';
import { O11yDashboard } from './o11y-dashboard';

export function VercelSection(): JSX.Element {
  return (
    <div className="grid grid-cols-12 gap-y-8 md:gap-x-8 overflow-hidden py-8 sm:py-12">
      <div className="col-span-12 md:col-span-5 flex flex-col gap-4">
        <h2 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40">
          Workflow SDK on Vercel
        </h2>
        <p className="text-lg text-muted-foreground text-balance">
          Zero infrastructure management, atomic versioning, and out of the box
          observability. Vercel makes Workflows easy.
        </p>
        <Button asChild size="default" className="rounded-full h-10 w-fit mt-2">
          <Link href="https://vercel.com/workflow" target="_blank">
            Learn more
          </Link>
        </Button>
      </div>
      <div className="col-span-12 md:col-span-7 self-center [mask-image:linear-gradient(to_bottom,black_40%,transparent_90%)]">
        <O11yDashboard svgId="o11y" className="w-full h-auto" />
      </div>
    </div>
  );
}
