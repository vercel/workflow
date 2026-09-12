import type { Metadata } from 'next';
import {
  generateWorldsGuideMetadata,
  WorldsGuidePage,
} from '@/components/worlds/worlds-guide-page';

export function generateMetadata(): Promise<Metadata> {
  return generateWorldsGuideMetadata('upgrading-to-v5', 'v5');
}

export default function Page() {
  return <WorldsGuidePage slug="upgrading-to-v5" version="v5" />;
}
