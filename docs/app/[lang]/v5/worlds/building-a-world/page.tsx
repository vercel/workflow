import type { Metadata } from 'next';
import {
  BuildingAWorldPage,
  generateBuildingAWorldMetadata,
} from '@/components/worlds/building-a-world-page';

export function generateMetadata(): Promise<Metadata> {
  return generateBuildingAWorldMetadata('v5');
}

export default function Page() {
  return <BuildingAWorldPage version="v5" />;
}
