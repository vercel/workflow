'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface BackLinkProps {
  href: string;
  label?: string;
}

export function BackLink({ href, label = 'Back' }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  );
}
