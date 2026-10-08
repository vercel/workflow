export function getStatusColorClass(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-geist-warning';
    case 'completed':
      return 'bg-geist-cyan';
    case 'failed':
      return 'bg-geist-error';
    default:
      return 'bg-gray-500';
  }
}
