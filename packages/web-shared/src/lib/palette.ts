export const SPAN_COLORS = {
  run: {
    icon: 'text-blue-900',
    bar: 'border-blue-500 bg-blue-200',
    line: '--ds-blue-400',
  },
  step: {
    icon: 'text-green-900',
    bar: 'border-green-500 bg-green-200',
    line: '--ds-green-400',
  },
  hook: {
    icon: 'text-gray-900',
    bar: 'border-gray-500 bg-gray-200',
    line: '--ds-gray-400',
  },
  sleep: {
    icon: 'text-gray-900',
    bar: 'border-gray-500 bg-gray-400',
    line: '--ds-gray-400',
  },
  failed: {
    icon: 'text-red-900',
    bar: 'border-red-500 bg-red-200',
    line: '--ds-red-400',
  },
  cancelled: {
    icon: 'text-gray-900',
    bar: 'border-gray-700 bg-gray-500',
    line: '--ds-gray-600',
  },
  retrying: {
    icon: 'text-gray-900',
    bar: 'border-gray-500 bg-gray-400',
    line: '--ds-gray-400',
  },
};

type Tone = keyof typeof SPAN_COLORS;

const RESOURCE_TONE: Record<string, Tone> = {
  run: 'run',
  step: 'step',
  sleep: 'sleep',
};

const STATE_TONE: Record<string, Tone> = {
  failed: 'failed',
  cancelled: 'cancelled',
  retrying: 'retrying',
  pending: 'hook',
};

export function getSpanColors(resource: string, state = '') {
  return SPAN_COLORS[STATE_TONE[state] ?? RESOURCE_TONE[resource] ?? 'hook'];
}
