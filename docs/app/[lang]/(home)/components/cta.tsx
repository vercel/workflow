import { Button } from '@vercel/geistdocs/components/button';
import Link from 'next/link';

export const CTA = () => (
  <section className="py-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
    <h2 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40">
      Create your first workflow today.
    </h2>
    <Button
      Component={Link}
      href="/docs/getting-started"
      size="large"
      className="w-fit h-10 rounded-full"
    >
      Get started
    </Button>
  </section>
);
