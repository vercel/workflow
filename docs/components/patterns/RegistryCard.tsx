import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { categoryLabels } from '@/lib/patterns/manifest';
import type { RegistryItem } from '@/lib/patterns/types';
import { getProviderLogo } from './logos';
import { VersionBadges } from './VersionBadges';

interface RegistryCardProps {
  item: RegistryItem;
}

export function RegistryCard({ item }: RegistryCardProps) {
  const Logo = getProviderLogo(item.logo);

  return (
    <Link href={`/patterns/${item.id}`} className="block group">
      <Card className="h-full transition-colors cursor-pointer overflow-hidden py-0! gap-2">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-start gap-3">
            {Logo && (
              <div
                aria-hidden="true"
                className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border bg-background text-foreground px-2"
              >
                <Logo size={18} />
              </div>
            )}
            <div className="space-y-1 min-w-0 flex-1">
              <CardTitle className="text-lg flex items-center gap-1.5 flex-wrap">
                <span className="truncate">{item.name}</span>
              </CardTitle>
              <CardDescription className="text-xs font-mono truncate">
                {item.installable !== false
                  ? item.shadcnSlug
                  : 'concept — read & adapt'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 px-4 pb-2">
          <p className="text-sm text-muted-foreground line-clamp-3">
            {item.description}
          </p>
        </CardContent>
        <div className="flex items-center flex-wrap gap-1.5 px-4 pb-4 pt-2">
          <VersionBadges versions={item.versions} />
          {item.categories.map((category) => (
            <Badge
              key={category}
              variant="outline"
              className="text-xs font-normal py-0.5 px-2"
            >
              {categoryLabels[category]}
            </Badge>
          ))}
        </div>
      </Card>
    </Link>
  );
}
