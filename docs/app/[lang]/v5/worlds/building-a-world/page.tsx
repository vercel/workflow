import type { Metadata } from 'next';
import {
  generateWorldsGuideMetadata,
  WorldsGuidePage,
} from '@/components/worlds/worlds-guide-page';

export function generateMetadata(): Promise<Metadata> {
  return generateWorldsGuideMetadata('building-a-world', 'v5');
}

export default function Page() {
  return <WorldsGuidePage slug="building-a-world" version="v5" />;
}
