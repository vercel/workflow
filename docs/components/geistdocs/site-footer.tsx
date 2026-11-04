import Link from 'next/link';
import { examplesRepositoryUrl, github } from '@/geistdocs';

// Workflow SDK links shown above the shared Vercel footer from geistdocs,
// which only lists Vercel-wide products. The changelog lives here rather than
// in the top nav: it is generated from package releases, so it is meant to be
// discoverable (search engines, agents, version links) without being promoted.
const links: { label: string; href: string; external?: boolean }[] = [
  { label: 'Changelog', href: '/changelog' },
  {
    label: 'GitHub',
    href: `https://github.com/${github.owner}/${github.repo}`,
    external: true,
  },
  { label: 'Examples', href: examplesRepositoryUrl, external: true },
];

export const SiteFooter = () => (
  <div className="mx-auto w-full max-w-[1448px] border-gray-alpha-400 border-t px-6 pt-6 text-sm">
    <nav
      aria-label="Workflow SDK"
      className="flex flex-wrap items-center gap-x-6 gap-y-2"
    >
      <span className="font-medium text-gray-1000">Workflow SDK</span>
      {links.map((link) =>
        link.external ? (
          <a
            className="text-gray-900 transition-colors hover:text-gray-1000 motion-reduce:transition-none"
            href={link.href}
            key={link.href}
            rel="noopener"
            target="_blank"
          >
            {link.label}
          </a>
        ) : (
          <Link
            className="text-gray-900 transition-colors hover:text-gray-1000 motion-reduce:transition-none"
            href={link.href}
            key={link.href}
          >
            {link.label}
          </Link>
        )
      )}
    </nav>
  </div>
);
