import { getWorldsData } from '@/lib/worlds-data';
import { WorldsDashboard } from './WorldsDashboard';

export async function WorldsDashboardServer() {
  const data = await getWorldsData();
  return <WorldsDashboard data={data} />;
}
