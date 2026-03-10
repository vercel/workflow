import { WORKFLOW_DEFINITIONS } from '@/app/workflows/definitions';
import HomeClient from './home-client';

export default function Home() {
  return <HomeClient workflowDefinitions={WORKFLOW_DEFINITIONS} />;
}
