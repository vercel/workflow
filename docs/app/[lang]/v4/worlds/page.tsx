import {
  VersionedWorldsPage,
  worldsMetadata,
} from '@/app/[lang]/_worlds/pages';

export const metadata = worldsMetadata;

const Page = () => <VersionedWorldsPage version="v4" />;

export default Page;
