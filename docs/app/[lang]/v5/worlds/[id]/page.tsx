import type { Metadata } from 'next';
import {
  generateWorldMetadata,
  officialWorldIds,
  WorldDetailPage,
} from '@/components/worlds/world-detail-page';

interface PageProps {
  params: Promise<{ id: string }>;
}

// Only official worlds have versioned docs; community world URLs redirect to
// their canonical /worlds/<id> page (handled inside WorldDetailPage).
export function generateStaticParams() {
  return officialWorldIds.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  return generateWorldMetadata(id, 'v5');
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  return <WorldDetailPage id={id} version="v5" />;
}
