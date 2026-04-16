import Link from 'next/link';
import type { JSX } from 'react';
import { Button } from '@/components/ui/button';
import { O11yDashboard } from './o11y-dashboard';

export function VercelSection(): JSX.Element {
  return (
    <div className="relative overflow-hidden">
      <div className="grid md:grid-cols-[1fr_1.5fr] px-4 py-8 sm:py-12 sm:px-12">
        <div className="grid gap-4 content-start">
          <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl">
            Workflow SDK on Vercel
          </h2>
          <p className="text-lg text-muted-foreground">
            Zero infrastructure management, atomic versioning, and out of the
            box observability. Vercel makes Workflows easy.
          </p>
          <Button
            asChild
            size="default"
            className="rounded-full h-10 w-fit mt-2"
          >
            <Link href="https://vercel.com/workflow" target="_blank">
              Learn more
            </Link>
          </Button>
        </div>
      </div>
      {/* Desktop — dashboard offset to the right */}
      <div className="hidden md:block absolute top-8 right-[-80px] w-[60%] [mask-image:linear-gradient(to_bottom,black_40%,transparent_90%),linear-gradient(to_left,transparent,black_10%)] [mask-composite:intersect]">
        <O11yDashboard svgId="o11y-desktop" className="w-full h-auto" />
      </div>
      {/* Mobile — dashboard below text */}
      <div className="md:hidden overflow-hidden mx-4 -mb-8 [mask-image:linear-gradient(to_bottom,black_40%,transparent_90%),linear-gradient(to_left,transparent,black_10%)] [mask-composite:intersect]">
        <O11yDashboard svgId="o11y-mobile" className="w-full h-auto" />
      </div>
    </div>
  );
}
