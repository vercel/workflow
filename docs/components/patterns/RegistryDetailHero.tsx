import { ChevronRight, ExternalLink, Github } from 'lucide-react';
import Link from 'next/link';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { RegistryItem } from '@/lib/patterns/types';
import { getProviderLogo } from './logos';
import { VersionBadges } from './VersionBadges';

interface RegistryDetailHeroProps {
  item: RegistryItem;
}

export function RegistryDetailHero({ item }: RegistryDetailHeroProps) {
  const Logo = getProviderLogo(item.logo);

  return (
    <section className="space-y-6 pt-8 sm:pt-12 pb-8 border-b">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/patterns">Patterns</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>
            <ChevronRight className="h-4 w-4" />
          </BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{item.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
        <div className="space-y-4 min-w-0">
          <div className="flex items-center gap-4">
            {Logo && (
              <div
                aria-hidden="true"
                className="flex h-14 min-w-14 shrink-0 items-center justify-center rounded-xl border bg-background text-foreground px-3"
              >
                <Logo size={28} />
              </div>
            )}
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              {item.name}
            </h1>
          </div>
          <div className="flex items-center flex-wrap gap-2">
            <p className="font-mono text-sm text-muted-foreground">
              {item.shadcnSlug}
            </p>
            <VersionBadges versions={item.versions} />
          </div>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {item.description}
          </p>
        </div>

        <div className="space-y-2 text-sm">
          {item.docsUrl &&
            !item.docsUrl.startsWith('https://workflow-sdk.dev') && (
              <a
                href={item.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-4 w-4 shrink-0" />
                <span>Provider docs</span>
              </a>
            )}
          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="h-4 w-4 shrink-0" />
              <span>Source</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
