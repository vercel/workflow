/**
 * Fill class for the status dot shown next to a run or step status.
 *
 * Follows the dashboard's status semantics: in-progress work is blue,
 * completed work is teal, failures are red, and everything else (pending,
 * cancelled, unknown) is gray. The palette tokens flip with the theme, so no
 * `dark:` override is needed. The dot is never the only cue: it always sits
 * next to the status label.
 */
export function getStatusColorClass(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-blue-700';
    case 'completed':
      return 'bg-teal-700';
    case 'failed':
      return 'bg-red-700';
    default:
      return 'bg-gray-700';
  }
}
