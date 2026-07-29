import type { Metadata } from 'next';
import {
  generateWorldMetadata,
  WorldDetailPage,
} from '@/components/worlds/world-detail-page';
import { getWorldIds } from '@/lib/worlds-data';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
  const ids = getWorldIds();
  return ids.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  return generateWorldMetadata(id, 'v4');
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  return <WorldDetailPage id={id} version="v4" />;
}
