import { WORKFLOW_DEFINITIONS } from '@/app/workflows/definitions';
import { AppShell } from './app-shell';

export default function Home() {
  return <AppShell workflowDefinitions={WORKFLOW_DEFINITIONS} />;
}
