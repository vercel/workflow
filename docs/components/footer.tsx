import Fumalink from 'fumadocs-core/link';
import { CustomLink, WithCustomLink } from './link';

type FooterItem = {
  href: string;
  label: string;
};

const FOOTER_ITEMS = {
  legal: [
    { href: 'https://vercel.com/legal/terms', label: 'Terms' },
    { href: 'https://vercel.com/legal/privacy-policy', label: 'Privacy' },
  ],
  resources: [
    { href: 'https://vercel.com/docs', label: 'Vercel Docs' },
    {
      href: 'https://vercel.com/docs/concepts/edge-network/custom-domains',
      label: 'Custom Domains',
    },
    { href: 'https://vercel.com/contact', label: 'Contact' },
  ],
};

type NavItemsProps = {
  category: FooterItem[];
};

const NavItems = ({ category }: NavItemsProps) => (
  <ul className="flex flex-col gap-y-3">
    {category.map((item) => {
      return (
        <li
          className="text-muted-foreground transition-colors hover:text-foreground"
          key={item.href}
        >
          <WithCustomLink href={item.href}>
            {({ link }) => <Fumalink href={link}>{item.label}</Fumalink>}
          </WithCustomLink>
        </li>
      );
    })}
  </ul>
);

export const Footer = () => (
  <footer className="w-full py-12">
    <div className="mx-auto flex w-full max-w-[914px] flex-col gap-y-12 px-4 md:px-6">
      <div className="flex w-full flex-col items-start justify-between gap-y-12 md:flex-row">
        <div className="flex items-center gap-2">
          <CustomLink href="https://vercel.com/" rel="noopener" target="_blank">
            <svg
              width={18}
              height={15}
              viewBox="0 0 76 65"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>Vercel</title>
              <path
                d="M37.5274 0L75.0548 65H0L37.5274 0Z"
                fill="currentColor"
              />
            </svg>
          </CustomLink>

          <p className="mx-1 text-muted-foreground">/</p>

          <CustomLink className="flex flex-row items-center gap-2" href="/">
            <span className="font-medium text-sm">Platforms</span>
          </CustomLink>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-36 gap-y-12 md:auto-cols-max md:grid-flow-col md:gap-x-24">
          <div className="flex flex-col gap-y-3 text-sm">
            <h4 className="font-medium">Resources</h4>
            <NavItems category={FOOTER_ITEMS.resources} />
          </div>

          <div className="flex flex-col gap-y-3 text-sm">
            <h4 className="font-medium">Legal</h4>
            <NavItems category={FOOTER_ITEMS.legal} />
          </div>
        </div>
      </div>
    </div>
  </footer>
);
