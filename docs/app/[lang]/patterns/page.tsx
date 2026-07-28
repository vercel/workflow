import { Button } from '@vercel/geistdocs/components/button';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RegistryGrid } from '@/components/patterns/RegistryGrid';
import { registryItems } from '@/lib/patterns/manifest';

export const metadata: Metadata = {
  title: 'Patterns | Workflow SDK',
  description:
    'Installable Workflow patterns for popular providers — durable, cancellable, replay-safe recipes you drop into your app with one shadcn command.',
};

export default function PatternsPage() {
  return (
    <div className="[&_h1]:tracking-tighter [&_h2]:tracking-tighter [&_h3]:tracking-tighter sm:mt-24">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Hero */}
        <section className="relative px-4 text-center pt-12 pb-12 sm:pb-16">
          <div className="relative z-10 mx-auto w-full max-w-3xl space-y-3 sm:space-y-5">
            <h1 className="text-center font-semibold text-4xl leading-[1.1] tracking-tight sm:text-5xl xl:text-6xl text-balance">
              Patterns
            </h1>
            <p className="text-balance text-muted-foreground sm:text-xl leading-relaxed">
              Installable Workflow patterns for popular providers. Durable,
              cancellable, replay-safe recipes you drop into your app with one{' '}
              <code className="font-mono text-base sm:text-lg bg-muted px-1.5 py-0.5 rounded">
                shadcn
              </code>{' '}
              command.
            </p>
          </div>
        </section>

        {/* Grid */}
        <RegistryGrid items={registryItems} />

        {/* CTA */}
        <section className="border-t px-4 py-8 sm:pt-24 sm:pb-16 sm:px-12">
          <div className="max-w-2xl mx-auto text-center space-y-4">
            <h2 className="font-semibold text-3xl tracking-tight sm:text-4xl">
              Build your own
            </h2>
            <p className="text-muted-foreground">
              Package any workflow as a shadcn-installable recipe and share it
              with the community. Each recipe is just a workflow file plus the
              API routes that drive it — anything you can write with the
              Workflow SDK qualifies.
            </p>
            <div className="flex justify-center gap-3 mt-8">
              <Button asChild size="lg">
                <Link href="/docs">Browse the docs</Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a
                  href="https://github.com/vercel/workflow"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Submit your recipe
                </a>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
