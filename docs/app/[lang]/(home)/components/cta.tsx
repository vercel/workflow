import Link from 'next/link';
import { Button } from '@/components/ui/button';

export const CTA = () => (
  <section className="px-8 sm:px-12 py-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
    <h2 className="font-semibold text-xl tracking-tight sm:text-2xl md:text-3xl lg:text-[40px]">
      Create your first workflow today.
    </h2>
    <Button asChild size="lg" className="w-fit text-base h-12">
      <Link href="/docs/getting-started">Get started</Link>
    </Button>
  </section>
);
