'use client';

import { Details as GeistdocsDetails } from '@vercel/geistdocs/components/details';
import { type ComponentProps, type MouseEvent, useEffect, useRef } from 'react';

type DetailsProps = ComponentProps<typeof GeistdocsDetails>;

/**
 * Geistdocs `Details` plus two behaviors for sections whose `Summary` holds a
 * heading (and therefore a TOC entry and a heading anchor):
 * - opens when the URL hash points at the heading or anything inside, so TOC
 *   entries and deep links reach content in a closed section;
 * - clicking the heading's anchor toggles the section, as clicking the rest of
 *   the summary does, instead of only changing the hash.
 */
export const Details = ({ onClick, ...props }: DetailsProps) => {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const openForHash = () => {
      const details = ref.current;
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!details || !id) return;
      const target = document.getElementById(id);
      if (!target || !details.contains(target)) return;
      details.open = true;
      target.scrollIntoView({ block: 'start' });
    };

    openForHash();
    window.addEventListener('hashchange', openForHash);
    return () => window.removeEventListener('hashchange', openForHash);
  }, []);

  const handleClick = (event: MouseEvent<HTMLDetailsElement>) => {
    onClick?.(event);
    const details = ref.current;
    if (!details || event.defaultPrevented) return;
    const anchor = (event.target as Element).closest('a[href^="#"]');
    const summary = anchor?.closest('summary');
    if (!anchor || summary?.parentElement !== details) return;
    event.preventDefault();
    details.open = !details.open;
    if (details.open) {
      window.history.replaceState(null, '', anchor.getAttribute('href'));
    }
  };

  return <GeistdocsDetails {...props} onClick={handleClick} ref={ref} />;
};
