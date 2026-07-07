import {
  generateWorldMetadata,
  generateWorldStaticParams,
  VersionedWorldDetailPage,
} from '@/app/[lang]/_worlds/pages';

export const generateStaticParams = generateWorldStaticParams;
export const generateMetadata = generateWorldMetadata;

const Page = (props: PageProps<'/[lang]/v4/worlds/[id]'>) => (
  <VersionedWorldDetailPage {...props} version="v4" />
);

export default Page;
